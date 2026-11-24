/**
 * AnimeGarden 站源模块
 *
 * https://animes.garden —— 动漫 BT 资源聚合（聚合 dmhy / bangumi.moe / mikan）。
 *
 * 实测结论（2026-11-24）：
 * - 公开 API https://api.animes.garden/resources，GET 即可，无需鉴权。
 *   分页参数 page/pageSize；过滤 type（动画/日剧/音乐/漫画/其他等）；
 *   搜索用 keywords=<kw>（GET，服务端支持）；tracker=true 时资源带 tracker 串。
 * - 响应 {status:"OK", resources:[...], pagination:{page,pageSize,complete}}，
 *   complete=true 表示没有下一页。
 * - 资源只有 BT 磁力链（magnet），没有 HTTP 直链，无法在线播放；
 *   videoUrl 直接给 magnet:?xt=urn:btih:...&tr=...，由播放端决定是否支持。
 * - 资源无封面；subjectId 对应 bgm.tv 条目，需要另调 api.bgm.tv
 *   （部分网络环境不通，失败则跳过封面，不影响列表）。
 * - "剧集"模型：一部"剧" = 一个 subject（番剧），分集 = 该 subject 下的各资源
 *   （按标题去重分集号困难，直接每个资源一章，标题即资源标题）。
 *   detail 需要按 subjectId 拉资源列表。
 */

var BASE = "https://api.animes.garden";

// 分类：type 过滤值实测可用：动画 / 日剧 / 音乐 / 漫画 / 其他
var CATEGORIES = ["动画", "日剧", "音乐", "漫画", "其他"];

var SUBJECT_CACHE_KEY = "animegarden:subject:";
var SUBJECT_TTL_MS = 7 * 24 * 3600 * 1000;

function apiJson(url) {
  var res = host.fetch({
    method: "GET",
    url: url,
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    timeoutMs: 20000,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error("AnimeGarden 接口请求失败（HTTP " + res.status + "）");
  }
  return JSON.parse(res.body);
}

function validCategory(category) {
  if (category === "" || category === undefined || category === null) return true;
  for (var i = 0; i < CATEGORIES.length; i++) {
    if (CATEGORIES[i] === String(category)) return true;
  }
  return false;
}

function categories() {
  return CATEGORIES.slice();
}

function pageSize() {
  return 20;
}

function toDrama(r) {
  return {
    id: String(r.subjectId || "raw:" + r.id),
    source: "animegarden",
    sourceId: String(r.subjectId || "raw:" + r.id),
    title: cleanTitle(r.title),
    name: cleanTitle(r.title),
    coverUrl: "",
    totalEpisode: 0,
    remark: formatSize(r.size),
    tags: [r.type || "", (r.fansub && r.fansub.name) || ""].filter(Boolean),
  };
}

function toChapter(r, index) {
  return {
    id: host.chapterId(String(r.subjectId || "raw:" + r.id), String(r.id)),
    source: "animegarden",
    title: r.title,
    videoUrl: magnetOf(r),
    currentEpisode: index,
    vip: false,
  };
}

function cleanTitle(title) {
  // 去掉开头的 [组名] 标记，让列表更干净；标题里保留原名兜底
  var t = String(title || "").replace(/^\s*\[[^\]]+\]\s*/, "");
  return t || String(title || "未知资源");
}

function formatSize(bytes) {
  var n = Number(bytes) || 0;
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + "GB";
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(0) + "MB";
  if (n >= 1024) return (n / 1024).toFixed(0) + "KB";
  return String(n) + "B";
}

function magnetOf(r) {
  var m = String(r.magnet || "");
  if (!m) return "";
  if (m.indexOf("?") < 0) return m;
  if (r.tracker) return m + r.tracker;
  return m;
}

function requestPage(params) {
  var qs = [];
  for (var k in params) {
    if (params[k] !== undefined && params[k] !== null && params[k] !== "") {
      qs.push(k + "=" + encodeURIComponent(params[k]));
    }
  }
  qs.push("tracker=true");
  var data = apiJson(BASE + "/resources?" + qs.join("&"));
  var list = data.resources || [];
  var pagination = data.pagination || {};
  return {
    items: list.map(toDrama),
    hasMore: !pagination.complete,
    rawList: list,
  };
}

function catalogPage(page, category) {
  if (!validCategory(category)) {
    throw new Error("AnimeGarden 模块没有分类 " + category);
  }
  var params = { page: page, pageSize: pageSize() };
  if (category) params.type = category;
  var out = requestPage(params);
  return { items: out.items, hasMore: out.hasMore };
}

function search(page, query) {
  var out = requestPage({ page: page, pageSize: pageSize(), keywords: query });
  return { items: out.items, hasMore: out.hasMore };
}

function detail(sourceId) {
  var sid = String(sourceId);
  if (sid.indexOf("raw:") === 0) {
    // 无 subjectId 的裸资源：构造只含占位信息的剧
    return {
      drama: {
        id: sid,
        source: "animegarden",
        sourceId: sid,
        title: "AnimeGarden 资源",
        name: "AnimeGarden 资源",
        coverUrl: "",
        totalEpisode: 0,
        remark: "",
        tags: [],
      },
      chapters: [],
    };
  }
  // 按 subject 拉资源列表（API 只支持 subject=<bangumi id> 过滤）
  var page = 1;
  var chapters = [];
  var drama = null;
  var guard = 0;
  while (guard++ < 20) {
    var out = requestPage({ page: page, pageSize: 50, subject: sid });
    if (out.rawList.length === 0) break;
    for (var i = 0; i < out.rawList.length; i++) {
      var r = out.rawList[i];
      if (!drama) {
        drama = toDrama(r);
      }
      chapters.push(toChapter(r, chapters.length));
    }
    if (!out.hasMore) break;
    page++;
  }
  if (!drama) {
    // 该 subject 下没有资源了（或 subjectId 无效），给出占位剧
    drama = {
      id: sid,
      source: "animegarden",
      sourceId: sid,
      title: "AnimeGarden #" + sid,
      name: "AnimeGarden #" + sid,
      coverUrl: "",
      totalEpisode: 0,
      remark: "",
      tags: [],
    };
  }
  drama.totalEpisode = chapters.length;
  return { drama: drama, chapters: chapters };
}

function resolveMedia(task) {
  var chapter = task.chapter || {};
  var url = String(chapter.videoUrl || "");
  if (!url) {
    throw new Error("该分集没有可用的磁力链");
  }
  return {
    url: url,
    credentials: {},
  };
}
