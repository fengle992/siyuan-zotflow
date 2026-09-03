# ZotFlow 同步（siyuan-zotflow）

把 Obsidian 中由 [ZotFlow](https://github.com/duanxianpi/zotflow) 生成的 Zotero 文献笔记，**增量同步**到思源笔记。未变动内容的**块 ID 保持不变**，因此闪卡、块引用与反向链接在同步后依然有效。

> 版本：v0.5.0 · 要求思源 ≥ 3.0.0（桌面端主窗口运行）

本项目配合 Obsidian 社区插件 ZotFlow 生成的笔记使用，精简聚焦于一件事：**从 Obsidian 同步文献笔记到思源**。

---

## 功能

| 功能 | 说明 |
|---|---|
| 增量同步 | 顶栏图标一键触发：按内容哈希检测新增 / 改动 / 删除，只更新有变化的文档 |
| 块 ID 保留 | 内容未变化的块保持原块 ID，闪卡、块引用、反链持续有效 |
| 全量覆盖 | 命令面板 / 设置页触发：删除目标路径下全部文档后重新导入（源目录大改后使用） |
| Frontmatter 剥离 | 自动去除 Obsidian YAML frontmatter，只导入正文 |
| 多语界面 | 简体中文 / English |

### 为什么闪卡不丢？

增量更新不走「删旧建新」，也不走整体 markdown 覆盖（那会重生成全部块 ID），而是：

1. 取旧文档 Block DOM（含旧块 ID）；
2. 通过内核将新内容渲染为带新 ID 的块 DOM；
3. 按块文本对齐，内容一致的块把新 ID 换回旧 ID；
4. 以 DOM 模式更新文档，内核原样保留 `data-node-id`。

只有内容真正变化的块才会获得新 ID（其原有关联本就因内容改变而失效）。

---

## 快速开始

1. 安装本插件并启用；
2. 打开 **设置 → ZotFlow 同步**：
   - 选择**目标笔记本**；
   - 填写**目标路径**（默认 `/ZotFlow`）；
   - 填写 **Obsidian 笔记目录**（磁盘绝对路径，如 `D:\OB\ZotFlow\Source\My Library`）；
3. 点击顶栏图标执行**增量同步**，或命令面板执行「**全量覆盖同步**」。

> ⚠️ 全量覆盖同步会先删除目标路径下的旧文档再重新导入，闪卡与块引用会失效，仅建议在源目录大改后使用。

---

## 安装

### 集市安装

在思源 **设置 → 集市 → 插件** 中搜索「ZotFlow」安装。

### 源码构建

```bash
git clone https://github.com/fengle992/siyuan-zotflow
cd siyuan-zotflow
npm install            # 国内可加 --registry=https://registry.npmmirror.com
npm run build          # 产出 index.js / index.css
```

将构建产物放入思源工作空间 `data/plugins/siyuan-zotflow/`，在「设置 → 插件」中启用。

---

## 开发

```bash
npm install
npm run dev        # esbuild watch，自动重编译 index.js
npm run build      # tsc 类型检查 + esbuild 生产构建
```

目录结构：

```
src/
├── index.ts       # 插件主类：增量/全量同步、块 ID 保留更新、设置
├── store.ts       # 设置与同步快照持久化
├── siyuan-api.ts  # 思源内核 API 封装
└── types.ts       # 类型定义
```

---

## 许可证与致谢

- 本插件：**AGPL-3.0-only**（继承自 ZotFlow）。
- 原版项目：[ZotFlow](https://github.com/duanxianpi/zotflow)，作者 [Xianpi Duan](https://github.com/duanxianpi/)。
