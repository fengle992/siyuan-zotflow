/**
 * SiYuan-zotflow 插件主入口（精简版）。
 * 仅保留「从 Obsidian 同步笔记」功能：
 * - 增量同步（顶栏图标）：只处理新增 / 改动 / 删除的 .md
 * - 全量覆盖同步（命令面板 + 设置面板按钮）：先清空再整目录重建
 */
import { Plugin, Setting, showMessage } from "siyuan";
import type { NotebookInfo, PluginSettings } from "./types";
import {
    DEFAULT_SETTINGS,
    loadSettings,
    loadSyncState,
    saveSettings,
    saveSyncState,
} from "./store";
import {
    createDocWithMd,
    getBlockDOM,
    listDocsByPath,
    listNotebooks,
    removeDoc,
    updateDocByDom,
    updateDocByMd,
} from "./siyuan-api";

declare global {
    interface Window {
        require?: NodeRequire;
    }
}

export default class SiYuanZotFlowPlugin extends Plugin {
    private settings: PluginSettings = { ...DEFAULT_SETTINGS };
    private syncing = false;

    private t(key: string, vars?: Record<string, string>): string {
        const i18n = this.i18n as unknown as Record<
            string,
            string
        > & { get?: (k: string) => string };
        let text = i18n[key];
        if (!text && typeof i18n.get === "function") text = i18n.get(key);
        if (!text) text = key;
        if (vars) {
            for (const k of Object.keys(vars)) {
                text = text.split(`{{${k}}}`).join(vars[k]);
            }
        }
        return text;
    }

    async onload(): Promise<void> {
        this.settings = await loadSettings(this);

        // 顶栏图标：增量同步（默认、轻量）
        this.addTopBar({
            icon: "iconRefresh",
            title: this.t("syncIncremental"),
            position: "left",
            callback: () => void this.syncIncremental(),
        });

        this.addCommand({
            langKey: "syncIncremental",
            callback: () => void this.syncIncremental(),
        });

        this.addCommand({
            langKey: "syncFull",
            callback: () => void this.syncFull(),
        });
    }

    onunload(): void {}

    // ---------------------------------------------------------------------
    // 公共辅助
    // ---------------------------------------------------------------------

    private getFs(): typeof import("fs") | undefined {
        try {
            return window.require?.("fs");
        } catch {
            return undefined;
        }
    }

    /** 规范化目标路径（不带末尾斜杠） */
    private getBase(): string {
        return this.settings.notePath.replace(/\/+$/, "") || "/ZotFlow";
    }

    /** 目标路径的父目录路径（用于 listDocsByPath） */
    private getParentPath(base: string): string {
        return base.includes("/")
            ? base.slice(0, base.lastIndexOf("/")) || "/"
            : "/";
    }

    /** 目标路径的最后一段（容器名） */
    private getContainerName(base: string): string {
        return base.includes("/") ? base.slice(base.lastIndexOf("/") + 1) : base;
    }

    /**
     * 查找目标容器文档的物理 path。返回 null 表示尚不存在。
     * removeDoc 需要物理 path（/文档ID.sy），因此必须先查出来。
     */
    private async findContainer(base: string): Promise<string | null> {
        const parentPath = this.getParentPath(base);
        const containerName = this.getContainerName(base);
        const siblings = await listDocsByPath(
            this.settings.notebookId,
            parentPath,
        );
        const found = siblings.find((n) => n.name === containerName);
        return found ? found.path : null;
    }

    /**
     * 读取 .md 文件内容，剥离 Obsidian 的 YAML frontmatter（笔记属性）。
     * frontmatter 以文件首行 "---" 开始，到下一个 "---" 结束，连同其后空行一并去除。
     */
    private readMarkdownFile(
        fs: typeof import("fs"),
        localPath: string,
    ): string {
        const raw = fs.readFileSync(localPath, "utf-8");
        const text = raw.replace(/^\uFEFF/, ""); // 去 BOM
        if (!text.startsWith("---")) return text;
        const lines = text.split(/\r?\n/);
        for (let i = 1; i < lines.length; i++) {
            if (lines[i].trim() === "---") {
                return lines
                    .slice(i + 1)
                    .join("\n")
                    .replace(/^\s*\n/, "");
            }
        }
        return text;
    }

    /**
     * 扫描 Obsidian 目录顶层 .md 文件，返回 文件名 -> { hash, content } 映射。
     * hash 为「剥离 frontmatter 后正文」的哈希，用于可靠的变化检测；
     * content 为剥离 frontmatter 后的正文，直接用于创建/更新文档。
     */
    private scanSource(
        fs: typeof import("fs"),
        dir: string,
    ): Map<string, { hash: string; content: string }> {
        const result = new Map<string, { hash: string; content: string }>();
        const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
        for (const file of files) {
            const localPath = `${dir.replace(/\\/g, "/")}/${file}`;
            try {
                const content = this.readMarkdownFile(fs, localPath);
                result.set(file.replace(/\.md$/i, ""), {
                    hash: this.hashString(content),
                    content,
                });
            } catch {
                // 读取失败的文件跳过
            }
        }
        return result;
    }

    /** 计算字符串哈希（cyrb53，53 位），用于内容变化检测。 */
    private hashString(str: string): string {
        let h1 = 0xdeadbeef;
        let h2 = 0x41c6ce57;
        for (let i = 0; i < str.length; i++) {
            const ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 =
            Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
            Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 =
            Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
            Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
    }

    /**
     * 从 Block DOM 中按文档顺序提取每个块的纯文本，用于新旧块对齐。
     * 文本归一化：去零宽空格、折叠空白，并忽略块属性区（protyle-attr）。
     */
    private parseBlockTexts(
        domHtml: string,
    ): Array<{ id: string; text: string }> {
        const doc = new DOMParser().parseFromString(domHtml, "text/html");
        const result: Array<{ id: string; text: string }> = [];
        doc.querySelectorAll("[data-node-id]").forEach((el) => {
            const id = el.getAttribute("data-node-id") || "";
            const content = el.querySelector(
                '[contenteditable="true"], [contenteditable]',
            );
            const raw = (content ?? el).textContent ?? "";
            const text = raw
                .replace(/\u200b/g, "")
                .replace(/\s+/g, " ")
                .trim();
            result.push({ id, text });
        });
        return result;
    }

    /**
     * 获取（或创建）一个**固定**的临时文档，用于让内核 Go Lute 把新 Markdown
     * 渲染成带块 ID 的 DOM。临时文档全程复用、永不删除，避免反复
     * createDocWithMd + removeDoc 的高频文件操作——那会与思源的数据仓库云同步
     * 并发竞争，触发内核 Lute 渲染 panic（nil pointer），进而导致文档树反复
     * reindex / 反复上传、「目录一直跳」。
     *
     * 临时文档放在笔记本根目录（而非 ZotFlow 容器内），这样不会被增量同步的
     * 「孤儿文档删除」逻辑误删。
     */
    private async getOrCreateTempDoc(): Promise<string> {
        const tempName = "__zotflow_sync_tmp";
        try {
            const root = await listDocsByPath(this.settings.notebookId, "/");
            const found = root.find((n) => n.name === tempName);
            if (found) return found.id;
        } catch {
            // 查询失败则走创建分支
        }
        return await createDocWithMd(
            this.settings.notebookId,
            `/${tempName}`,
            "",
        );
    }

    /**
     * 更新文档正文，同时尽量保留「内容未变化」块的 ID。
     *
     * 背景：闪卡、块引用、反链、自定义属性都绑定块 ID。若用 updateBlock 的
     * markdown 模式整体覆盖，内核 Lute 会重新生成所有块 ID，导致这些关联失效
     * （用户反馈「闪卡找不到原文」）。
     *
     * 关键：插件的 JS 运行环境里拿不到 Lute，无法在本地把 Markdown 转成带 ID
     * 的 Block DOM。因此借用内核 Go Lute：通过一个固定临时文档把新 Markdown
     * 渲染成带新 ID 的块 DOM，再按文本对齐把旧 ID 钉回：
     *   1. getBlockDOM(docId) 取旧 DOM（含旧块 ID）；
     *   2. updateBlock(markdown) 更新固定临时文档（内核生成带新 ID 的块）；
     *   3. getBlockDOM(tempId) 取新 DOM（含新块 ID）；
     *   4. 按「块纯文本」匹配，内容一致的块把新 ID 换回旧 ID；
     *   5. updateBlock(dataType=dom) 更新目标文档（内核原样保留 data-node-id）。
     *
     * 内容变化 / 新增的块拿不到旧 ID，会保留新生成的 ID（这部分关联
     * 本就因内容变化而失效，可接受）。
     */
    private async updateDocPreservingIds(
        docId: string,
        newMarkdown: string,
    ): Promise<void> {
        console.log(`[ZotFlow] updateDocPreservingIds ${docId}: start (fixed-tmp)`);

        // 1. 旧 DOM（含旧块 ID）
        const oldDom = await getBlockDOM(docId);
        const oldBlocks = this.parseBlockTexts(oldDom);

        // 2. 复用固定临时文档，用内核 Go Lute 生成带新 ID 的块 DOM
        const tempDocId = await this.getOrCreateTempDoc();
        try {
            await updateDocByMd(tempDocId, newMarkdown);
            const newDom = await getBlockDOM(tempDocId);
            const newBlocks = this.parseBlockTexts(newDom);

            // 3. 旧块按文本建索引（用队列，处理重复文本块时按出现顺序消费）
            const oldByText = new Map<string, string[]>();
            for (const block of oldBlocks) {
                if (!block.text) continue;
                const queue = oldByText.get(block.text);
                if (queue) queue.push(block.id);
                else oldByText.set(block.text, [block.id]);
            }

            // 4. 逐新块替换：文本命中的块用旧 ID，未命中的保留新 ID
            let result = newDom;
            let replaced = 0;
            for (const block of newBlocks) {
                if (!block.text) continue;
                const queue = oldByText.get(block.text);
                if (!queue || queue.length === 0) continue;
                const oldId = queue.shift() as string;
                if (oldId !== block.id) {
                    result = result
                        .split(`data-node-id="${block.id}"`)
                        .join(`data-node-id="${oldId}"`);
                    replaced++;
                }
            }

            console.log(
                `[ZotFlow] updateDocPreservingIds ${docId}: oldBlocks=${oldBlocks.length}, newBlocks=${newBlocks.length}, replaced=${replaced}`,
            );

            // 5. DOM 模式更新（内核原样保留 data-node-id）
            await updateDocByDom(docId, result);
            console.log(
                `[ZotFlow] updateDocPreservingIds ${docId}: updateBlock(dom) OK`,
            );
        } finally {
            // 6. 清空临时文档：内容变化/新增块保留的是临时文档生成的新块 ID，
            // 若临时文档不清理，这些 ID 会与临时文档自身块 ID 重复（跨文档
            // 冲突），触发思源 duplicated-tree reindex。清空后临时文档无子块，
            // 无 ID 冲突。
            try {
                await updateDocByMd(tempDocId, "");
            } catch (e) {
                console.warn(
                    `[ZotFlow] failed to clear temp doc ${tempDocId}:`,
                    e,
                );
            }
        }
    }

    // ---------------------------------------------------------------------
    // 增量同步
    // ---------------------------------------------------------------------

    /**
     * 增量同步：只处理「新增」「改动」「删除」三类文件。
     * - 新增：源目录有、思源没有 → createDocWithMd
     * - 改动：源文件内容哈希与快照不同 → updateBlock 就地更新（保留文档 ID）
     * - 删除：思源有、源目录已删除 → removeDoc
     * 用内容哈希而非 mtime 判断改动，可靠且不受 mtime 精度影响。
     */
    async syncIncremental(): Promise<void> {
        if (this.syncing) return;
        const dir = (this.settings.obsidianDir || "").trim();
        if (!dir) {
            showMessage(this.t("obsidianDirNotSet"), 5000, "error");
            return;
        }
        if (!this.settings.notebookId) {
            showMessage(this.t("notConfigured"), 4000, "error");
            return;
        }
        const fs = this.getFs();
        if (!fs) {
            showMessage(this.t("fsNotAvailable"), 5000, "error");
            return;
        }

        const base = this.getBase();
        this.syncing = true;
        showMessage(this.t("incrementalStarted"), 4000, "info");

        try {
            // 1. 扫描源目录（读取内容 + 计算哈希）
            const source = this.scanSource(fs, dir);

            // 2. 读取思源现有子文档（name -> { id, path }）
            const existing = new Map<string, { id: string; path: string }>();
            const containerPath = await this.findContainer(base);
            if (containerPath) {
                const children = await listDocsByPath(
                    this.settings.notebookId,
                    containerPath,
                );
                for (const child of children) {
                    existing.set(child.name, { id: child.id, path: child.path });
                }
            }

            // 3. 读取上次同步快照（name -> hash）
            const snapshot: Record<string, string> = {};
            const loaded = await loadSyncState(this);
            for (const key of Object.keys(loaded)) {
                snapshot[key] = String(loaded[key]);
            }

            let created = 0;
            let updated = 0;
            let deleted = 0;
            let failed = 0;

            // 4. 删除：思源有、源目录没有
            for (const [name, node] of existing) {
                if (!source.has(name)) {
                    try {
                        await removeDoc(this.settings.notebookId, node.path);
                        deleted++;
                        delete snapshot[name];
                    } catch (err) {
                        console.error(`[ZotFlow] failed to delete ${name}:`, err);
                        failed++;
                    }
                }
            }

            // 5. 新增 + 改动
            for (const [name, { hash, content }] of source) {
                const docPath = `${base}/${name}`;
                if (!existing.has(name)) {
                    // 新增
                    try {
                        await createDocWithMd(
                            this.settings.notebookId,
                            docPath,
                            content,
                        );
                        created++;
                        snapshot[name] = hash;
                    } catch (err) {
                        console.error(
                            `[ZotFlow] failed to create ${name}:`,
                            err,
                        );
                        failed++;
                    }
                } else if (snapshot[name] !== hash) {
                    // 改动：就地更新正文，并尽量保留未变块的 ID（避免闪卡失效）
                    try {
                        await this.updateDocPreservingIds(
                            existing.get(name)!.id,
                            content,
                        );
                        updated++;
                        snapshot[name] = hash;
                    } catch (err) {
                        console.error(
                            `[ZotFlow] failed to update ${name}:`,
                            err,
                        );
                        failed++;
                    }
                }
                // 未变化：跳过（snapshot[name] 保持 === hash）
            }

            // 6. 保存快照（仅保存成功项；失败项保留旧哈希，下次自动重试）
            await saveSyncState(this, snapshot);

            showMessage(
                this.t("incrementalDone", {
                    created: String(created),
                    updated: String(updated),
                    deleted: String(deleted),
                    failed: String(failed),
                }),
                6000,
                failed > 0 ? "error" : "info",
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            showMessage(this.t("syncFailed") + message, 8000, "error");
        } finally {
            this.syncing = false;
        }
    }

    // ---------------------------------------------------------------------
    // 全量覆盖同步
    // ---------------------------------------------------------------------

    /**
     * 全量覆盖同步：先删除整个目标容器，再重建容器并逐个导入全部 .md。
     * 保证思源与 Obsidian 目录完全一致（含删除），幂等。
     */
    async syncFull(): Promise<void> {
        if (this.syncing) return;
        const dir = (this.settings.obsidianDir || "").trim();
        if (!dir) {
            showMessage(this.t("obsidianDirNotSet"), 5000, "error");
            return;
        }
        if (!this.settings.notebookId) {
            showMessage(this.t("notConfigured"), 4000, "error");
            return;
        }
        const fs = this.getFs();
        if (!fs) {
            showMessage(this.t("fsNotAvailable"), 5000, "error");
            return;
        }

        const base = this.getBase();
        if (
            !confirm(
                this.t("fullSyncConfirm") ||
                    "全量覆盖同步会删除 /ZotFlow 下全部文档并重新导入，闪卡、块引用等关联将失效。确定继续？",
            )
        ) {
            return;
        }
        this.syncing = true;
        showMessage(this.t("fullSyncStarted"), 4000, "info");

        try {
            // 1. 删除旧容器（连带子文档）
            try {
                const containerPath = await this.findContainer(base);
                if (containerPath) {
                    await removeDoc(this.settings.notebookId, containerPath);
                }
            } catch {
                // 尚不存在，忽略
            }

            // 2. 重建容器
            await createDocWithMd(
                this.settings.notebookId,
                base,
                "# ZotFlow\n",
            );

            // 3. 逐个导入全部 .md
            const source = this.scanSource(fs, dir);
            let imported = 0;
            let failed = 0;
            const nextSnapshot: Record<string, string> = {};
            for (const [name, { hash, content }] of source) {
                const docPath = `${base}/${name}`;
                try {
                    await createDocWithMd(
                        this.settings.notebookId,
                        docPath,
                        content,
                    );
                    imported++;
                    nextSnapshot[name] = hash;
                } catch (err) {
                    console.error(`[ZotFlow] failed to import ${name}:`, err);
                    failed++;
                }
            }

            // 4. 保存快照
            await saveSyncState(this, nextSnapshot);

            showMessage(
                this.t("fullSyncDone", {
                    imported: String(imported),
                    failed: String(failed),
                }),
                6000,
                failed > 0 ? "error" : "info",
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            showMessage(this.t("syncFailed") + message, 8000, "error");
        } finally {
            this.syncing = false;
        }
    }

    // ---------------------------------------------------------------------
    // 设置
    // ---------------------------------------------------------------------

    openSetting(): void {
        void this.buildSettings();
    }

    private async buildSettings(): Promise<void> {
        let notebooks: NotebookInfo[] = [];
        try {
            notebooks = await listNotebooks();
        } catch {
            notebooks = [];
        }

        const ui: Record<string, HTMLElement> = {};

        const setting = new Setting({
            width: "680px",
            height: "auto",
            confirmCallback: () => {
                void this.applySettings(ui);
            },
        });

        setting.addItem({
            title: this.t("notebook"),
            description: this.t("notebookDesc"),
            createActionElement: () => {
                const select = document.createElement("select");
                select.className = "b3-select";
                const placeholder = document.createElement("option");
                placeholder.value = "";
                placeholder.textContent = "—";
                select.appendChild(placeholder);
                for (const notebook of notebooks) {
                    const option = document.createElement("option");
                    option.value = notebook.id;
                    option.textContent = notebook.name;
                    select.appendChild(option);
                }
                select.value = this.settings.notebookId;
                ui.notebook = select;
                return select;
            },
        });

        setting.addItem({
            title: this.t("notePath"),
            description: this.t("notePathDesc"),
            createActionElement: () => {
                const input = document.createElement("input");
                input.className = "b3-text-field";
                input.value = this.settings.notePath;
                ui.notePath = input;
                return input;
            },
        });

        setting.addItem({
            title: this.t("obsidianDir"),
            description: this.t("obsidianDirDesc"),
            createActionElement: () => {
                const input = document.createElement("input");
                input.className = "b3-text-field";
                input.placeholder =
                    "D:\\OB\\Fengle\\7-zotero\\ZotFlow\\Source\\My Library";
                input.value = this.settings.obsidianDir;
                ui.obsidianDir = input;
                return input;
            },
        });

        setting.addItem({
            title: this.t("fullSyncAction"),
            description: this.t("fullSyncActionDesc"),
            createActionElement: () => {
                const button = document.createElement("button");
                button.className = "b3-button b3-button--outline";
                button.textContent = this.t("fullSyncAction");
                button.addEventListener("click", () => {
                    this.applyUiToSettings(ui);
                    void this.syncFull();
                });
                return button;
            },
        });

        setting.open("ZotFlow");
    }

    private async applySettings(
        ui: Record<string, HTMLElement>,
    ): Promise<void> {
        this.applyUiToSettings(ui);
        await saveSettings(this, this.settings);
        showMessage(this.t("settingsSaved"), 3000, "info");
    }

    /**
     * 从设置面板 UI 读取当前值，同步到内存中的 this.settings。
     * 注意：不会写入磁盘，需要调用方自行决定是否 saveSettings。
     */
    private applyUiToSettings(ui: Record<string, HTMLElement>): void {
        const value = (key: string): string =>
            (ui[key] as HTMLInputElement | HTMLSelectElement)?.value ?? "";

        this.settings.notePath = value("notePath") || "/ZotFlow";
        this.settings.obsidianDir = value("obsidianDir");

        if (ui.notebook) {
            const select = ui.notebook as HTMLSelectElement;
            this.settings.notebookId = select.value;
            this.settings.notebookName =
                select.selectedOptions[0]?.textContent ?? "";
        }
    }
}
