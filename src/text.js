// Local, free natural-language helpers for comment text — no API, no extra deps.
// Japanese word segmentation uses the built-in Intl.Segmenter (Node 22+).

const STOPWORDS = new Set([
  // PII-scrub placeholders left in the text
  "email", "url", "phone", "handle",
  // Japanese high-frequency function/filler words (length >= 2)
  "する", "した", "して", "です", "ます", "ました", "これ", "それ", "あれ", "この", "その",
  "あの", "ない", "なく", "いる", "ある", "なる", "なっ", "思う", "思い", "感じ", "みたい",
  "本当", "とても", "すごく", "ほんと", "ちょっと", "から", "けど", "ので", "という", "って",
  "こと", "もの", "ため", "よう", "さん", "たち", "じゃ", "でも", "また", "もう", "まだ",
  "自分", "今回", "動画", "コメント", "チャンネル", "ない", "いう",
  // Chinese common
  "这个", "那个", "什么", "怎么", "可以", "没有", "就是", "因为", "所以", "我们", "你们",
  "他们", "视频", "评论", "已经", "还是", "这样", "那样", "真的",
  // English common
  "the", "and", "for", "you", "this", "that", "are", "was", "with", "have", "but",
  "not", "can", "all", "your", "from", "they", "video", "just", "really", "no",
]);

let segmenter;
function getSegmenter() {
  if (segmenter === undefined) {
    try {
      segmenter = new Intl.Segmenter("ja", { granularity: "word" });
    } catch {
      segmenter = null;
    }
  }
  return segmenter;
}

export function tokenize(text) {
  const value = String(text ?? "");
  const tokens = [];
  const seg = getSegmenter();
  if (seg) {
    for (const part of seg.segment(value)) {
      if (part.isWordLike) {
        tokens.push(part.segment.trim().toLowerCase());
      }
    }
  } else {
    for (const word of value.toLowerCase().split(/[\s\p{P}\p{S}]+/u)) {
      if (word) {
        tokens.push(word);
      }
    }
  }
  return tokens.filter(
    (word) => word.length >= 2 && !/^\d+$/.test(word) && !STOPWORDS.has(word),
  );
}

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const HASHTAG_RE = /[#＃][^\s#＃.,!?、。！？]+/gu;

export function extractEmojis(text) {
  return String(text ?? "").match(EMOJI_RE) ?? [];
}

export function extractHashtags(text) {
  return (String(text ?? "").match(HASHTAG_RE) ?? []).map((tag) =>
    tag.replace(/^＃/, "#"),
  );
}

export function buildBigrams(tokens) {
  const output = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    output.push(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return output;
}

function topCounts(map, limit) {
  return [...map.entries()]
    .map(([term, count]) => ({ term, count }))
    .sort((left, right) => right.count - left.count || left.term.localeCompare(right.term))
    .slice(0, limit);
}

// Build word / emoji / hashtag frequency tables from comment rows ({ text_content }).
export function buildCommentTerms(
  commentRows,
  { wordLimit = 40, phraseLimit = 30, emojiLimit = 15, hashtagLimit = 15 } = {},
) {
  const words = new Map();
  const phrases = new Map();
  const emojis = new Map();
  const hashtags = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const row of commentRows ?? []) {
    const text = row.text_content;
    const tokens = tokenize(text);
    for (const word of tokens) {
      bump(words, word);
    }
    for (const phrase of buildBigrams(tokens)) {
      bump(phrases, phrase);
    }
    for (const emoji of extractEmojis(text)) {
      bump(emojis, emoji);
    }
    for (const tag of extractHashtags(text)) {
      bump(hashtags, tag);
    }
  }
  return {
    words: topCounts(words, wordLimit),
    phrases: topCounts(phrases, phraseLimit),
    emojis: topCounts(emojis, emojiLimit),
    hashtags: topCounts(hashtags, hashtagLimit),
  };
}
