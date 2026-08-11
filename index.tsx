/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { proxyLazyWebpack } from "@webpack";
import { AuthenticationStore, UserSettingsActionCreators } from "@webpack/common";

const logger = new Logger("FavoritesServer");

type FavoritesProto = Record<string, {
    id: string;
    nickname: string;
    type: string;
    channelType: {
        value: number;
    };
    order: number;
    parentId: string;
}>;

function searchProtoClassField(localName: string, protoClass: any) {
    const field = protoClass?.fields?.find((field: any) => field.localName === localName);
    if (!field) return;

    const fieldGetter = Object.values(field).find(value => typeof value === "function") as any;
    return fieldGetter?.();
}

const PreloadedUserSettingsActionCreators = proxyLazyWebpack(() => UserSettingsActionCreators.PreloadedUserSettingsActionCreators);
const FavoritesSettingsActionCreators = proxyLazyWebpack(() => searchProtoClassField("favorites", PreloadedUserSettingsActionCreators.ProtoClass));


const favoritesServerSettings = definePluginSettings({}).withPrivateSettings<{
    syncedPerAccountState?: Record<string, {
        favoriteChannels: FavoritesProto;
    }>;
}>();



export default definePlugin({
    name: "FavoritesServer",
    description: "Client only version of the favorites experiment",
    authors: [{ name: "velvox", id: BigInt("218072060923084802") }],
    start() {
        logger.info("started");
    },
    stop() {
        logger.info("stopped");
    },
    settings: favoritesServerSettings,

    patches: [
        // when we connect we want to handle the proto change ourselves
        {
            find: '"UserSettingsProtoStore"',
            replacement: [
                {
                    match: /(?<=CONNECTION_OPEN:function\((\i)\){)/,
                    replace: (_, props) => `$self.handleProtoChange(${props}.userSettingsProto,${props}.user);`
                },
                {
                    match: /let{settings:/,
                    replace: "arguments[0].local||$self.handleProtoChange(arguments[0].settings.proto);$&"
                }
            ],
        },
        // forcefully enable favorite server
        {
            find: '"FavoriteStore"',
            replacement: [
                {
                    match: /(get favoriteGuildEnabled\(\){)return \i}/,
                    replace: "$1return true;}"
                },
                {
                    match: /(get favoriteGuildVisibleSetting\(\){)return \i}/,
                    replace: "$1return true;}"
                },
            ]
        },
        // when we write to the proto we want to handle the favorite channel update ourselves
        // this is to ensure we don't hit the discord api
        {
            find: '"UserSettingsProtoLastWriteTimes"',
            replacement: [
                {
                    match: /if\(null==(\i).protoToSave\)/,
                    replace: "if($1.protoToSave.favorites !== null){$self.handleFavoriteChannel($1.protoToSave.favorites); return;}else if(null==$1.protoToSave)"
                }
            ]
        },
        // really stupid patch to enable the favorite server experiment
        {
            find: "2026-01-favorites-server",
            replacement: [
                {
                    match: /defaultConfig:{enabled:!1,hasHigherPrivileges:!1}/,
                    replace: "defaultConfig:{enabled:1,hasHigherPrivileges:1}"
                }
            ]
        }
    ],
    handleProtoChange(proto: any, user: any) {
        try {
            if (proto == null || typeof proto === "string") return;

            proto.favorites ??= FavoritesSettingsActionCreators.create();

            const s = favoritesServerSettings.store;

            const userId = AuthenticationStore.getId();
            if (!userId) return;

            if (!s.syncedPerAccountState?.[userId]) {
                s.syncedPerAccountState ??= {};
                s.syncedPerAccountState[userId] ??= {
                    favoriteChannels: {},
                };
            }
            const favoritesSettingOverwrite = FavoritesSettingsActionCreators.create({
                ...proto.favorites,
                favoriteChannels: s.syncedPerAccountState[userId].favoriteChannels,
            });
            proto.favorites = favoritesSettingOverwrite;

        } catch (err) {
            logger.error(err);
        }
    },

    handleFavoriteChannel(favorites: { favoriteChannels: FavoritesProto, muted: boolean; }) {
        console.log("favorites proto update", favorites);

        if (favorites.favoriteChannels === null) {
            return;
        }

        const s = favoritesServerSettings.store;
        const userId = AuthenticationStore.getId();
        if (!userId) return;

        if (!s.syncedPerAccountState?.[userId]) {
            s.syncedPerAccountState ??= {};
            s.syncedPerAccountState[userId] ??= {
                favoriteChannels: {},
            };
        }

        for (const id in favorites.favoriteChannels) {
            s.syncedPerAccountState[userId].favoriteChannels[id] = favorites.favoriteChannels[id];
        }
        logger.info("synced per account state", s.syncedPerAccountState);
    },

});
