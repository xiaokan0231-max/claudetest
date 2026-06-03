// Lightweight, dependency-free sentiment heuristic for JA/ZH/emoji comment text.
// Deterministic and free (no API). A baseline only — raw comment text is retained
// in the database so scores can be recomputed with a better model later.

const POSITIVE = [
  // Japanese
  "最高", "すごい", "凄い", "好き", "面白い", "おもしろい", "神", "感動", "ありがとう",
  "わかりやすい", "役に立", "良い", "いいね", "素晴らし", "応援", "可愛い", "かわいい", "楽しい",
  // Chinese
  "喜欢", "好看", "厉害", "感谢", "有用", "支持", "太棒", "优秀", "感动", "好评", "牛逼",
  // English
  "great", "good", "love", "awesome", "amazing", "helpful", "thanks", "best",
];

const NEGATIVE = [
  // Japanese
  "最悪", "ひどい", "つまらない", "嫌い", "がっかり", "詐欺", "ステマ", "うざ", "無理",
  "ダメ", "炎上", "気持ち悪", "つまんない", "意味不明", "金返せ",
  // Chinese
  "垃圾", "难看", "无聊", "讨厌", "失望", "骗", "差评", "退钱", "无语", "烂片",
  // English
  "bad", "worst", "hate", "boring", "scam", "trash", "awful", "disappointing",
];

const POSITIVE_EMOJI = ["😀", "😄", "😍", "🥰", "👍", "❤️", "🔥", "😂", "🤣", "👏", "✨", "💯"];
const NEGATIVE_EMOJI = ["👎", "😡", "🤬", "💩", "😞", "😢", "😠", "🙄"];

function countHits(haystack, needles) {
  let total = 0;
  for (const needle of needles) {
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      total += 1;
      index = haystack.indexOf(needle, index + needle.length);
    }
  }
  return total;
}

// Returns { label: "positive" | "neutral" | "negative", score, positiveHits, negativeHits }.
export function scoreSentiment(text) {
  const value = String(text ?? "");
  const lower = value.toLowerCase();
  const positive = countHits(lower, POSITIVE) + countHits(value, POSITIVE_EMOJI);
  const negative = countHits(lower, NEGATIVE) + countHits(value, NEGATIVE_EMOJI);
  const score = positive - negative;
  const label = score > 0 ? "positive" : score < 0 ? "negative" : "neutral";
  return { label, score, positiveHits: positive, negativeHits: negative };
}
