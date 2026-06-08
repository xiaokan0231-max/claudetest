export type Locale = "zh-CN" | "ja-JP";

export function formatCount(value: unknown, locale: Locale): string {
  if (value === null || value === undefined || value === "") return "N/A";
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? value.toLocaleString(locale)
      : value.toLocaleString(locale, { maximumFractionDigits: 2 });
  }
  try {
    return BigInt(String(value)).toLocaleString(locale);
  } catch {
    const number = Number(value);
    return Number.isFinite(number)
      ? number.toLocaleString(locale, { maximumFractionDigits: Number.isInteger(number) ? 0 : 2 })
      : String(value);
  }
}

export function formatDecimal(value: unknown, digits = 2): string {
  if (value === null || value === undefined || value === "") return "N/A";
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "N/A";
}

export function formatPercent(value: unknown): string {
  const formatted = formatDecimal(value);
  return formatted === "N/A" ? formatted : `${formatted}%`;
}

export function formatJst(value: unknown, locale: Locale, includeTime = true): string {
  if (!value) return "N/A";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "N/A";
  return new Intl.DateTimeFormat(locale, {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  }).format(date);
}

export function topics(value: unknown): string[] {
  return String(value ?? "")
    .split("||")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function thumbnail(postId: string, url?: string | null): string {
  return url || `https://i.ytimg.com/vi/${postId}/hqdefault.jpg`;
}

const categoryLabels: Record<string, { "zh-CN": string; "ja-JP": string }> = {
  "1": { "zh-CN": "电影与动画", "ja-JP": "映画とアニメ" },
  "2": { "zh-CN": "汽车", "ja-JP": "自動車" },
  "10": { "zh-CN": "音乐", "ja-JP": "音楽" },
  "15": { "zh-CN": "宠物与动物", "ja-JP": "ペットと動物" },
  "17": { "zh-CN": "体育", "ja-JP": "スポーツ" },
  "19": { "zh-CN": "旅行与活动", "ja-JP": "旅行とイベント" },
  "20": { "zh-CN": "游戏", "ja-JP": "ゲーム" },
  "22": { "zh-CN": "人物与博客", "ja-JP": "ブログ" },
  "23": { "zh-CN": "喜剧", "ja-JP": "コメディー" },
  "24": { "zh-CN": "娱乐", "ja-JP": "エンターテイメント" },
  "25": { "zh-CN": "新闻与政治", "ja-JP": "ニュースと政治" },
  "26": { "zh-CN": "生活方式", "ja-JP": "ハウツーとスタイル" },
  "27": { "zh-CN": "教育", "ja-JP": "教育" },
  "28": { "zh-CN": "科技", "ja-JP": "科学と技術" },
};

export function categoryLabel(
  categoryId: unknown,
  fallback: unknown,
  locale: Locale,
): string {
  const id = String(categoryId ?? "");
  return categoryLabels[id]?.[locale] ?? String(fallback ?? (id || "N/A"));
}
