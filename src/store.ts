/**
 * 设置持久化（精简版：仅 Obsidian 同步）。
 * 通过 Plugin.loadData/saveData 存储，key 为 "settings"。
 * 思源插件在 data/storage/siyuan-zotflow/ 下落地 JSON。
 */
import type { PluginSettings } from "./types";
import type { Plugin } from "siyuan";

const SETTINGS_KEY = "zotflow-settings";
const SYNC_STATE_KEY = "zotflow-sync-state";

/**
 * 增量同步状态：记录每个源文件（文件名不含 .md 后缀）最近一次同步时的
 * 内容哈希（剥离 frontmatter 后的正文）。用于判断「是否改动」，从而只处理
 * 新增/改动/删除。用内容哈希而非 mtime，避免 mtime 不更新/精度不足导致漏同步。
 */
export type SyncState = Record<string, string>;

export const DEFAULT_SETTINGS: PluginSettings = {
    notebookId: "",
    notebookName: "",
    notePath: "/ZotFlow",
    obsidianDir: "D:\\OB\\Fengle\\7-zotero\\ZotFlow\\Source\\My Library",
};

export async function loadSettings(plugin: Plugin): Promise<PluginSettings> {
    const raw = await plugin.loadData(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
        const parsed = JSON.parse(raw) as Partial<PluginSettings>;
        return { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

export async function saveSettings(
    plugin: Plugin,
    settings: PluginSettings,
): Promise<void> {
    await plugin.saveData(SETTINGS_KEY, JSON.stringify(settings));
}

export async function loadSyncState(plugin: Plugin): Promise<SyncState> {
    const raw = await plugin.loadData(SYNC_STATE_KEY);
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as SyncState;
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

export async function saveSyncState(
    plugin: Plugin,
    state: SyncState,
): Promise<void> {
    await plugin.saveData(SYNC_STATE_KEY, JSON.stringify(state));
}
