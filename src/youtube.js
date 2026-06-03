import { chunk, sleep } from "./utils.js";

const API_BASE = "https://www.googleapis.com/youtube/v3";

export const QUOTA_COSTS = {
  searchList: 100,
  videosList: 1,
  channelsList: 1,
  categoriesList: 1,
  commentThreadsList: 1,
};

export function buildYouTubeApiUrl(resource, params) {
  const url = new URL(`${API_BASE}/${resource}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

export function estimateCollectionQuota(queries, activePostCount, commentRequests = 0) {
  const maximumDiscoveredPosts =
    queries.reduce((sum, query) => sum + Number(query.max_results), 0) + 50;
  const maximumRequestedPosts = maximumDiscoveredPosts + Number(activePostCount);
  const detailRequests = Math.ceil(maximumRequestedPosts / 50);
  const channelRequests = Math.ceil(maximumRequestedPosts / 50);
  return (
    queries.length * QUOTA_COSTS.searchList +
    QUOTA_COSTS.videosList +
    QUOTA_COSTS.categoriesList +
    detailRequests * QUOTA_COSTS.videosList +
    channelRequests * QUOTA_COSTS.channelsList +
    Number(commentRequests) * QUOTA_COSTS.commentThreadsList
  );
}

function sanitizeApiError(payload, status) {
  const reason = payload?.error?.errors?.[0]?.reason;
  const message = payload?.error?.message;
  return new Error(
    `YouTube API request failed (${status})${reason ? ` [${reason}]` : ""}${
      message ? `: ${message}` : ""
    }`,
  );
}

export class YouTubeClient {
  constructor({ apiKey, quotaBudget, fetchImpl = globalThis.fetch }) {
    this.apiKey = apiKey;
    this.quotaBudget = quotaBudget;
    this.fetchImpl = fetchImpl;
    this.quotaUsed = 0;
    this.requestCount = 0;
  }

  ensureBudget(cost) {
    if (this.quotaUsed + cost > this.quotaBudget) {
      throw new Error(
        `Collection would exceed SNS_QUOTA_BUDGET=${this.quotaBudget} units`,
      );
    }
  }

  async request(resource, params, cost) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      this.ensureBudget(cost);
      const url = buildYouTubeApiUrl(resource, {
        ...params,
        key: this.apiKey,
      });
      this.quotaUsed += cost;
      this.requestCount += 1;

      try {
        const response = await this.fetchImpl(url, {
          headers: { Accept: "application/json" },
        });
        const payload = await response.json().catch(() => ({}));
        if (response.ok) {
          return payload;
        }
        const error = sanitizeApiError(payload, response.status);
        if (response.status !== 429 && response.status < 500) {
          throw error;
        }
        lastError = error;
      } catch (error) {
        lastError = error;
        if (
          String(error.message).includes("YouTube API request failed") &&
          !String(error.message).includes("(429)") &&
          !/\(5\d\d\)/.test(String(error.message))
        ) {
          throw error;
        }
      }

      if (attempt < 2) {
        await sleep(500 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  async searchVideos(query, publishedAfter) {
    return this.request(
      "search",
      {
        part: "snippet",
        type: "video",
        q: query.query_text,
        regionCode: query.region_code,
        relevanceLanguage: query.relevance_language,
        safeSearch: query.safe_search,
        order: "date",
        publishedAfter: publishedAfter.toISOString(),
        maxResults: query.max_results,
      },
      QUOTA_COSTS.searchList,
    );
  }

  async listPopularVideos(regionCode = "JP") {
    return this.request(
      "videos",
      {
        part: "snippet,contentDetails,statistics",
        chart: "mostPopular",
        regionCode,
        maxResults: 50,
      },
      QUOTA_COSTS.videosList,
    );
  }

  async listVideos(ids) {
    const items = [];
    for (const idChunk of chunk(ids, 50)) {
      const payload = await this.request(
        "videos",
        {
          part: "snippet,contentDetails,statistics",
          id: idChunk.join(","),
          maxResults: 50,
        },
        QUOTA_COSTS.videosList,
      );
      items.push(...(payload.items ?? []));
    }
    return items;
  }

  async listChannels(ids) {
    const items = [];
    for (const idChunk of chunk(ids, 50)) {
      const payload = await this.request(
        "channels",
        {
          part: "snippet,statistics",
          id: idChunk.join(","),
          maxResults: 50,
        },
        QUOTA_COSTS.channelsList,
      );
      items.push(...(payload.items ?? []));
    }
    return items;
  }

  async listCategories(regionCode = "JP") {
    return this.request(
      "videoCategories",
      {
        part: "snippet",
        regionCode,
      },
      QUOTA_COSTS.categoriesList,
    );
  }

  async listCommentThreads(videoId, { pageToken, order = "relevance", maxResults = 100 } = {}) {
    return this.request(
      "commentThreads",
      {
        part: "snippet",
        videoId,
        order,
        maxResults,
        pageToken,
        textFormat: "plainText",
      },
      QUOTA_COSTS.commentThreadsList,
    );
  }
}
