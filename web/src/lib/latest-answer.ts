import type { PaneAnswerResponse } from "@/lib/types";

export type CopyLatestAnswerResult = "copied" | "empty" | "unsupported" | "failed";

type ClipboardLike = {
  write?: Clipboard["write"];
  writeText?: Clipboard["writeText"];
};

export interface CopyLatestAnswerDeps {
  clipboard?: ClipboardLike;
  ClipboardItem?: typeof ClipboardItem;
  Blob?: typeof Blob;
}

const NO_ANSWER = Symbol("copy-latest-answer-no-answer");

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function answerText(response: PaneAnswerResponse): string {
  if (!response.available || response.text.trim() === "") throw NO_ANSWER;
  return response.text;
}

/**
 * Fetch and copy the server-selected latest assistant answer.
 *
 * The ClipboardItem path intentionally calls `write` before the answer request settles. Safari
 * requires that call to happen during the user gesture; the item's text payload can resolve later.
 */
export function copyLatestAnswer(
  fetchAnswer: () => Promise<PaneAnswerResponse>,
  deps: CopyLatestAnswerDeps = {},
): Promise<CopyLatestAnswerResult> {
  const clipboard =
    hasOwn(deps, "clipboard")
      ? deps.clipboard
      : typeof navigator === "undefined"
        ? undefined
        : navigator.clipboard;
  const itemConstructor = hasOwn(deps, "ClipboardItem")
    ? deps.ClipboardItem
    : typeof ClipboardItem === "function"
      ? ClipboardItem
      : undefined;
  const blobConstructor = hasOwn(deps, "Blob")
    ? deps.Blob
    : typeof Blob === "function"
      ? Blob
      : undefined;

  let answerPromise: Promise<PaneAnswerResponse>;
  try {
    answerPromise = Promise.resolve(fetchAnswer());
  } catch {
    return Promise.resolve("failed");
  }

  const textPromise = answerPromise.then(answerText);

  if (clipboard?.write && itemConstructor) {
    const blobPromise = textPromise.then((text) => {
      if (!blobConstructor) throw new Error("Blob is unavailable");
      return new blobConstructor([text], { type: "text/plain" });
    });

    try {
      const item = new itemConstructor({ "text/plain": blobPromise });
      const writePromise = Promise.resolve(clipboard.write([item]));
      return Promise.all([blobPromise, writePromise]).then(
        () => "copied",
        (reason) => (reason === NO_ANSWER ? "empty" : "failed"),
      );
    } catch {
      void blobPromise.catch(() => undefined);
      return Promise.resolve("failed");
    }
  }

  return textPromise.then(
    (text) => {
      if (!clipboard?.writeText) return "unsupported";
      try {
        return Promise.resolve(clipboard.writeText(text)).then(
          () => "copied",
          () => "failed",
        );
      } catch {
        return "failed";
      }
    },
    (reason) => (reason === NO_ANSWER ? "empty" : "failed"),
  );
}
