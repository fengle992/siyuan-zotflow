/**
 * 思源内核 API 封装（精简版：笔记本列表 + 文档列表 + 删除 + Markdown 创建）。
 */
import type { NotebookInfo } from "./types";

async function kernelRequest<T>(
    path: string,
    body?: Record<string, unknown>,
): Promise<T> {
    const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
    });
    const result = (await response.json()) as {
        code: number;
        msg: string;
        data: T;
    };
    if (result.code !== 0) {
        throw new Error(`SiYuan API error (${result.code}): ${result.msg}`);
    }
    return result.data;
}

/** 列出全部笔记本 */
export async function listNotebooks(): Promise<NotebookInfo[]> {
    const data = await kernelRequest<{ notebooks: NotebookInfo[] }>(
        "/api/notebook/lsNotebooks",
        {},
    );
    return data.notebooks ?? [];
}

/** 文档树节点 */
export interface DocNode {
    id: string;
    name: string;
    path: string; // 物理路径，如 /20260901145135-f9artpc.sy
    icon?: string;
    name1?: string;
    alias?: string;
    memo?: string;
    bookmark?: string;
    count?: number;
    size?: number;
}

/** 列出指定笔记本路径下的文档 */
export async function listDocsByPath(
    notebookId: string,
    path: string,
): Promise<DocNode[]> {
    const data = await kernelRequest<{ files: DocNode[] }>(
        "/api/filetree/listDocsByPath",
        { notebook: notebookId, path },
    );
    return data.files ?? [];
}

/**
 * 删除笔记本内指定物理路径的文档（连同子文档一并删除，移入回收站）。
 * path 必须是物理路径，形如 "/20260901122608-dj88tla/20260901145135-f9artpc.sy"；
 * 如需按 HPath 删除，请先通过 listDocsByPath 取得物理 path。
 */
export async function removeDoc(
    notebookId: string,
    path: string,
): Promise<void> {
    await kernelRequest<null>("/api/filetree/removeDoc", {
        notebook: notebookId,
        path,
    });
}

/**
 * 通过 Markdown 在指定笔记本路径下创建文档，返回新文档 ID。
 * path 形如 "/ZotFlow"（相对笔记本根，不带末尾斜杠）。
 */
export async function createDocWithMd(
    notebookId: string,
    path: string,
    markdown: string,
): Promise<string> {
    const data = await kernelRequest<string>("/api/filetree/createDocWithMd", {
        notebook: notebookId,
        path,
        markdown,
    });
    return data;
}

/**
 * 就地更新指定文档的正文内容（保留文档 ID，不重建、不删除）。
 * id 为文档 ID（即根块 ID），markdown 为替换后的正文（不含文档标题）。
 *
 * 说明：createDocWithMd 对已存在 path 会「新建同名文档」而非覆盖，所以
 * 更新已存在文档必须用 updateBlock（按 id 更新块内容）。此前用
 * removeDoc + createDocWithMd 的「删旧建新」方案会触发内核 nil pointer
 * panic（filetree.go → Lute protyle 渲染器），故改用本接口。
 */
export async function updateDocByMd(
    docId: string,
    markdown: string,
): Promise<void> {
    await kernelRequest<null>("/api/block/updateBlock", {
        id: docId,
        dataType: "markdown",
        data: markdown,
    });
}

/**
 * 获取文档的 Block DOM（HTML 字符串）。每个块带 data-node-id（块 ID），
 * 用于「保留块 ID」的增量更新：拿到旧块 ID 后，把新内容里内容一致的块
 * 重新钉回旧 ID，避免闪卡、块引用、反链因块 ID 变化而失效。
 */
export async function getBlockDOM(docId: string): Promise<string> {
    const data = await kernelRequest<{ dom: string; id: string }>(
        "/api/block/getBlockDOM",
        { id: docId },
    );
    return data.dom;
}

/**
 * 用 Block DOM 就地更新文档正文（dataType=dom）。
 * 与 markdown 更新不同，DOM 里的 data-node-id 会被内核原样保留，
 * 因此只要在 DOM 里携带旧块 ID，就能在更新内容的同时保住块 ID。
 */
export async function updateDocByDom(
    docId: string,
    dom: string,
): Promise<void> {
    await kernelRequest<null>("/api/block/updateBlock", {
        id: docId,
        dataType: "dom",
        data: dom,
    });
}
