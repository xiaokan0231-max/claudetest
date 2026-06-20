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

// Negation markers. A positive term immediately preceded by a NEG_BEFORE marker
// (不好看, "not good") or followed by a NEG_AFTER suffix (好きじゃない) is flipped
// to negative. Still a heuristic, but it stops the common false positives where
// the negated form keeps the positive substring.
const NEG_BEFORE = [
  "不", "没", "沒", "别", "無", "无", "未", "毫无",
  "not ", "no ", "never ", "without ", "isn't ", "wasn't ", "aren't ",
  "don't ", "doesn't ", "didn't ", "ain't ", "n't ",
];
// NB: no ねえ/ねぇ — after a positive term those are the emphatic particle
// (すごいねえ! = "so amazing!"), not negation.
const NEG_AFTER = ["じゃない", "ではない", "なかった", "ない", "なく", "ません"];

function isNegated(lower, index, length) {
  const before = lower.slice(Math.max(0, index - 8), index);
  const after = lower.slice(index + length, index + length + 8);
  return (
    NEG_BEFORE.some((marker) => before.endsWith(marker)) ||
    NEG_AFTER.some((marker) => after.startsWith(marker))
  );
}

function countPositiveLexicon(lower) {
  let positive = 0;
  let negated = 0;
  for (const needle of POSITIVE) {
    const lowered = needle.toLowerCase();
    let index = lower.indexOf(lowered);
    while (index !== -1) {
      if (isNegated(lower, index, lowered.length)) {
        negated += 1;
      } else {
        positive += 1;
      }
      index = lower.indexOf(lowered, index + lowered.length);
    }
  }
  return { positive, negated };
}

// Returns { label: "positive" | "neutral" | "negative", score, positiveHits, negativeHits }.
export function scoreSentiment(text) {
  const value = String(text ?? "");
  const lower = value.toLowerCase();
  const { positive: positiveTerms, negated } = countPositiveLexicon(lower);
  const positive = positiveTerms + countHits(value, POSITIVE_EMOJI);
  // A negated positive ("不好看") counts as a negative signal.
  const negative =
    countHits(lower, NEGATIVE) + countHits(value, NEGATIVE_EMOJI) + negated;
  const score = positive - negative;
  const label = score > 0 ? "positive" : score < 0 ? "negative" : "neutral";
  return { label, score, positiveHits: positive, negativeHits: negative };
}
