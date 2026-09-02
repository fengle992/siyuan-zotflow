/** 插件数据类型定义（精简版：仅 Obsidian 同步） */

export interface PluginSettings {
    /** 目标笔记本 ID */
    notebookId: string;
    /** 目标笔记本名称（展示用） */
    notebookName: string;
    /** 笔记本内路径，如 /ZotFlow */
    notePath: string;
    /** Obsidian 笔记目录（磁盘绝对路径），整目录导入 */
    obsidianDir: string;
}

export interface NotebookInfo {
    id: string;
    name: string;
}
