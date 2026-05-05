// ============= 文本云盘 Worker（基于Cloudflare）=============
// 环境变量：ADMIN_UUID（必填）
// D1 绑定：DB（必填）
// KV 绑定：SHARE_KV（强烈推荐，用于加速访客访问）
//仅供学习使用，勿用于非法
//基于GPLv3协议的开源特性

const DEFAULT_FRONTEND_URL = "https://text-disk-ui.pages.dev";
const ADMIN_COOKIE_MAX_AGE = 43200; // 默认10min，登录有效期（秒），可改为 604800（7天）等

let ADMIN_UUID = null;
const KV_TTL = 60 * 60 * 24 * 7;
const CACHE_TTL = 60 * 60 * 24 * 365;
let dbInitialized = false;
async function initDB(env) {
  if (dbInitialized) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,is_folder INTEGER NOT NULL,content TEXT,token TEXT,created_at INTEGER DEFAULT(unixepoch()),updated_at INTEGER DEFAULT(unixepoch()));CREATE INDEX IF NOT EXISTS idx_path_prefix ON files(path);`,
  ).run();
  dbInitialized = true;
}
function getCacheKey(request, token, path) {
  const u = new URL(request.url);
  return new Request(
    `${u.origin}/__cache__/${token}_${encodeURIComponent(path)}`,
  );
}
async function getCFCache(request, token, path) {
  return caches.default.match(getCacheKey(request, token, path));
}
async function putCFCache(request, token, path, content) {
  return caches.default.put(
    getCacheKey(request, token, path),
    new Response(content, {
      headers: {
        "Content-Type": "text/plain;charset=utf-8",
        "Cache-Control": `public,max-age=${CACHE_TTL}`,
      },
    }),
  );
}
async function purgeCFCache(request, token, path) {
  return caches.default.delete(getCacheKey(request, token, path));
}
function uuidv4() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
    (
      c ^
      (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))
    ).toString(16),
  );
}
function isFolder(name) {
  return name.endsWith("/");
}
function getParentPath(path) {
  const p = path.split("/").filter(Boolean);
  p。pop();
  return p.length ? p.join("/") + "/" : "";
}
function getBaseName(path) {
  const p = path.split("/");
  return isFolder(path) ? p[p.length - 2] + "/" : p[p.length - 1];
}
function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}
async function getKVKey(token, path) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(path),
  );
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
  return `share_${token}_${hex}`;
}
async function setShareCache(env, token, path, content, oldToken) {
  if (!env.SHARE_KV || !token) return;
  const opts = KV_TTL > 0 ? { expirationTtl: KV_TTL } : {};
  await env.SHARE_KV.put(
    await getKVKey(token, path),
    JSON。stringify({ token, content }),
    opts，
  );
  if (oldToken && oldToken !== token)
    await env.SHARE_KV.delete(await getKVKey(oldToken, path));
}
async function updateShareCache(env, token, path, content) {
  if (!env.SHARE_KV || !token) return;
  await env.SHARE_KV.put(
    await getKVKey(token, path),
    JSON.stringify({ token, content }),
    KV_TTL > 0 ? { expirationTtl: KV_TTL } : {},
  );
}
async function deleteShareCache(env, token, path) {
  if (env.SHARE_KV && token)
    await env.SHARE_KV.delete(await getKVKey(token, path));
}
async function getShareCache(env, token, path) {
  if (!env.SHARE_KV) return null;
  const raw = await env.SHARE_KV.get(await getKVKey(token, path));
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o.token === token ? (o.content ?? "") : null;
  } catch {
    return null;
  }
}
async function getFileList(env) {
  return (
    await env.DB.prepare(
      "SELECT path, is_folder FROM files ORDER BY path",
    ).all()
  ).results.map((r) => ({ name: r.path, isFolder: r.is_folder === 1 }));
}
async function getFileContent(env, filename) {
  if (isFolder(filename)) return "";
  return (
    (
      await env.DB.prepare("SELECT content FROM files WHERE path = ?")
        .bind(filename)
        .all()
    ).results[0]?.content || ""
  );
}
async function saveFileContent(env, filename, content, token = null) {
  if (isFolder(filename)) return null;
  if (token === null) {
    const r = await env.DB.prepare("SELECT token FROM files WHERE path = ?")
      。bind(filename)
      。全部();
    token = r.results[0]?.token || null;
  }
  const res = await env.DB.prepare(
    "UPDATE files SET content = ?, updated_at = unixepoch() WHERE path = ? AND is_folder = 0",
  )
    .bind(content, filename)
    .run();
  if (res.changes === 0) throw new Error("文件不存在，请先创建文件");
  if (token) await updateShareCache(env, token, filename, content);
  return token;
}
async function deleteFile(env, filename) {
  const isDir = isFolder(filename);
  let items = [];
  if (isDir) {
    const r = await env.DB.prepare(
      "SELECT token, path FROM files WHERE path = ? OR path LIKE ? || '%'",
    )
      .bind(filename, filename)
      .all();
    items = r.results
      。map((x) => ({ token: x.token, path: x.path }))
      .filter((t) => t.token);
    await env.DB.prepare(
      "DELETE FROM files WHERE path = ? OR path LIKE ? || '%'",
    )
      。bind(filename， filename)
      .run();
  } else {
    const r = await env.DB.prepare(
      "SELECT token, path FROM files WHERE path = ?",
    )
      .bind(filename)
      。全部();
    if (r.results.length && r.results[0].token)
      items.push({ token: r.results[0].token, path: r.results[0].path });
    await env.DB.prepare("DELETE FROM files WHERE path = ?")
      .bind(filename)
      .run();
  }
  for (const t of items) await deleteShareCache(env, t.token, t.path);
  return items;
}
async function renameFile(env, oldName, newName) {
  if (oldName === newName) return [];
  if (
    (
      await env.DB.prepare("SELECT path FROM files WHERE path = ?")
        。bind(newName)
        .all()
    ).results.length
  )
    throw new Error("目标名称已存在");
  const isDir = isFolder(oldName);
  let tokens = [];
  if (isDir) {
    const od = oldName.endsWith("/") ? oldName : oldName + "/",
      nd = newName.endsWith("/") ? newName : newName + "/";
    const r = await env.DB.prepare(
      "SELECT token, path FROM files WHERE path LIKE ? || '%'",
    )
      .bind(od)
      .all();
    tokens = r.results
      .map((x) => ({ token: x.token, path: x.path }))
      .filter((t) => t.token);
    await env.DB.prepare(
      "UPDATE files SET path = REPLACE(path, ?, ?), updated_at = unixepoch() WHERE path LIKE ? || '%'",
    )
      .bind(od, nd, od)
      。run();
  } else {
    const r = await env.DB.prepare(
      "SELECT token, path FROM files WHERE path = ?",
    )
      。bind(oldName)
      .all();
    tokens = r.results
      。map((x) => ({ token: x.token, path: x.path }))
      .filter((t) => t.token);
    await env.DB.prepare(
      "UPDATE files SET path = ?, updated_at = unixepoch() WHERE path = ?",
    )
      .bind(newName, oldName)
      .run();
  }
  for (const t of tokens) await deleteShareCache(env, t.token, t.path);
  return tokens;
}
async function moveItem(env, itemName, targetFolder) {
  let target = targetFolder.endsWith("/") ? targetFolder : targetFolder + "/";
  if (isFolder(itemName) && target.startsWith(itemName))
    throw new Error("不能将文件夹移动到自身或其子文件夹中");
  const base = getBaseName(itemName),
    newPath = target + base;
  if (
    (
      await env.DB.prepare("SELECT path FROM files WHERE path = ?")
        .bind(newPath)
        .all()
    ).results.length
  )
    throw new Error("目标位置已存在同名文件");
  return renameFile(env, itemName, newPath);
}
async function getFileToken(env, filename) {
  return (
    (
      await env.DB.prepare("SELECT token FROM files WHERE path = ?")
        .bind(filename)
        .all()
    ).results[0]?.token || ""
  );
}
async function saveFileToken(env, filename, token) {
  const old =
    (
      await env.DB.prepare("SELECT token FROM files WHERE path = ?")
        .bind(filename)
        .all()
    ).results[0]?.token || null;
  const res = await env.DB.prepare(
    "UPDATE files SET token = ?, updated_at = unixepoch() WHERE path = ?",
  )
    .bind(token, filename)
    .run();
  if (res.changes === 0)
    await env.DB.prepare(
      "INSERT INTO files (path, is_folder, content, token, created_at, updated_at) VALUES (?, 0, '', ?, unixepoch(), unixepoch())",
    )
      .bind(filename, token)
      .run();
  await setShareCache(
    env,
    token,
    filename,
    await getFileContent(env, filename),
    old,
  );
}
async function createNewFile(env, fullPath) {
  await env.DB.prepare(
    "INSERT INTO files (path, is_folder, content, token, created_at, updated_at) VALUES (?, 0, '', NULL, unixepoch(), unixepoch())",
  )
    .bind(fullPath)
    .run();
}
async function createNewFolder(env, fullPath) {
  await env.DB.prepare(
    "INSERT INTO files (path, is_folder, content, token, created_at, updated_at) VALUES (?, 1, NULL, NULL, unixepoch(), unixepoch())",
  )
    .bind(fullPath)
    。run();
}
async function proxyFrontend(frontendUrl, request, ctx) {
  const cacheKey = new URL(frontendUrl);
  const cached = await caches.default.match(cacheKey);
  if (cached)
    return new Response(cached.body, {
      headers: {
        ...cached.headers,
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
        "Content-Type": "text/html;charset=utf-8",
      },
    });
  const res = await fetch(frontendUrl, { cf: { cacheEverything: true } });
  const newRes = new Response(res.body, {
    status: res.status,
    headers: {
      ...res.headers,
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      "Content-Type": "text/html;charset=utf-8",
    },
  });
  ctx。waitUntil(caches.default.put(cacheKey, newRes.clone()));
  return newRes;
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function text(data, status = 200, headers = {}) {
  return new Response(data, {
    status,
    headers: { "Content-Type": "text/plain;charset=utf-8", ...headers },
  });
}
export default {
  async fetch(request, env, ctx) {
    ADMIN_UUID = env.ADMIN_UUID || ADMIN_UUID;
    const url = new URL(request.url);
    const pathname = url.pathname.slice(1);
    const parts = pathname.split("/");
    if (!ADMIN_UUID) return text("⚠️ 请设置环境变量 ADMIN_UUID", 400);
    if (parts[0] === "sub" && parts.length >= 3) {
      try {
        const token = parts[1],
          decodedPath = decodeURIComponent(parts.slice(2).join("/"));
        const cached = await getCFCache(request, token, decodedPath);
        if (cached) return cached;
        const kv = await getShareCache(env, token, decodedPath);
        if (kv !== null) {
          ctx.waitUntil(putCFCache(request, token, decodedPath, kv));
          return text(kv);
        }
        await initDB(env);
        const saved = await getFileToken(env, decodedPath);
        if (!saved || token !== saved)
          return text("Token无效或文件不存在", 403);
        const content = await getFileContent(env, decodedPath);
        ctx.waitUntil(
          Promise.all([
            updateShareCache(env, saved, decodedPath, content),
            putCFCache(request, token, decodedPath, content),
          ]),
        );
        return text(content);
      } catch (e) {
        return text("访问失败：" + e.message, 400);
      }
    }
    if (parts[0] === "sub")
      return text("格式错误：/sub/<Token>/<路径>/<文件名>", 400);
    await initDB(env);
    if (pathname === "admin" || pathname.startsWith("admin/")) {
      if (
        request.method === "GET" &&
        !url.searchParams.has("action") &&
        !url.searchParams.has("file") &&
        !request.headers.get("X-File-Name")
      ) {
        const frontendUrl = env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
        return proxyFrontend(frontendUrl, request, ctx);
      }
      const body = request.method === "POST" ? await request.text() : "";
      if (body.startsWith("LOGIN|")) {
        const inp = body.split("|")[1];
        if (inp === ADMIN_UUID) {
          return text("登录成功", 200, {
            "Set-Cookie": `admin_token=${ADMIN_UUID};Path=/;HttpOnly;SameSite=Lax;Secure;Max-Age=${ADMIN_COOKIE_MAX_AGE}`,
          });
        }
        return text("UUID错误", 401);
      }
      if (body.startsWith("LOGOUT")) {
        return text("已登出", 200, {
          "Set-Cookie": `admin_token=;Path=/;HttpOnly;SameSite=Lax;Secure;Max-Age=0`,
        });
      }
      const adminToken = getCookie(request, "admin_token");
      if (adminToken !== ADMIN_UUID) return text("未登录", 401);
      if (url.searchParams.get("action") === "get_tree")
        return json(await getFileList(env));
      if (body.startsWith("FILE_TOKEN|")) {
        const [_, filename, custom] = body.split("|");
        if (!filename) return text("缺少文件名", 400);
        await saveFileToken(env, filename, custom?.trim() || uuidv4());
        return text(await getFileToken(env, filename));
      }
      if (body.startsWith("GET_TOKEN|")) {
        const [_, filename] = body.split("|");
        if (!filename) return text("缺少文件名", 400);
        return text((await getFileToken(env, filename)) || "该文件未生成Token");
      }
      if (body.startsWith("FILE_OP|")) {
        try {
          const [_, op, ...args] = body.split("|");
          switch (op) {
            case "new": {
              const full = (args[1] || "") + args[0]?.trim();
              if (
                (
                  await env.DB.prepare("SELECT path FROM files WHERE path = ?")
                    .bind(full)
                    .all()
                ).results.length
              )
                throw new Error("文件已存在");
              await createNewFile(env, full);
              return json({ success: true, path: full });
            }
            case "newfolder": {
              let fn = args[0]?.trim();
              if (!fn) throw new Error("文件夹名不能为空");
              const full = (args[1] || "") + (fn.endsWith("/") ? fn : fn + "/");
              if (
                (
                  await env.DB.prepare("SELECT path FROM files WHERE path = ?")
                    .bind(full)
                    .all()
                ).results.length
              )
                throw new Error("文件夹已存在");
              await createNewFolder(env, full);
              return json({ success: true, path: full });
            }
            case "delete": {
              const items = await deleteFile(env, args[0]);
              ctx.waitUntil(
                Promise.all(
                  items.map((t) => purgeCFCache(request, t.token, t.path)),
                ),
              );
              return text("删除成功");
            }
            case "rename": {
              const items = await renameFile(env, args[0], args[1]);
              ctx.waitUntil(
                Promise.all(
                  items.map((t) => purgeCFCache(request, t.token, t.path)),
                ),
              );
              return text("重命名成功");
            }
            case "move": {
              const items = await moveItem(env, args[0], args[1]);
              ctx.waitUntil(
                Promise.all(
                  (items || []).map((t) =>
                    purgeCFCache(request, t.token, t.path),
                  ),
                ),
              );
              return text("移动成功");
            }
            default:
              return text("未知操作", 400);
          }
        } catch (e) {
          return text(e.message, 400);
        }
      }
      if (
        request.method === "POST" &&
        !body.startsWith("FILE_TOKEN|") &&
        !body.startsWith("GET_TOKEN|") &&
        !body.startsWith("FILE_OP|") &&
        !body.startsWith("LOGIN|") &&
        !body.startsWith("LOGOUT")
      ) {
        let filename = decodeURIComponent(
          request.headers.get("X-File-Name") || "",
        );
        if (!filename) return text("缺少文件名", 400);
        const inlineToken = request.headers.get("X-File-Token")
          ? decodeURIComponent(request.headers.get("X-File-Token"))
          : null;
        const used = await saveFileContent(env, filename, body, inlineToken);
        if (used) ctx.waitUntil(purgeCFCache(request, used, filename));
        return text("保存成功");
      }
      if (url.searchParams.get("action") === "get_content") {
        return text(
          await getFileContent(
            env,
            decodeURIComponent(url.searchParams.get("file") || ""),
          ),
        );
      }
      const frontendUrl = env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
      return proxyFrontend(frontendUrl, request, ctx);
    }
    return text("Not Found", 404);
  },
};
