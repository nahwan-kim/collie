import type { PaneAnswerResponse } from "@/lib/types";

import {
  copyLatestAnswer,
  type CopyLatestAnswerDeps,
} from "./latest-answer";

const answer = (text = "assistant answer"): PaneAnswerResponse => ({
  paneId: "w1:p1",
  available: true,
  uuid: "a1",
  ts: "",
  text,
  truncated: false,
});

const unavailable = (): PaneAnswerResponse => ({
  paneId: "w1:p1",
  available: false,
  reason: "no-answer",
});

class FakeClipboardItem {
  readonly data: Record<string, unknown>;

  constructor(data: Record<string, unknown>) {
    this.data = data;
  }
}

const fakeClipboardItem = FakeClipboardItem as unknown as typeof ClipboardItem;
const fakeBlob = Blob as typeof Blob;

function deps(
  clipboard: CopyLatestAnswerDeps["clipboard"],
  ClipboardItem: CopyLatestAnswerDeps["ClipboardItem"] = undefined,
): CopyLatestAnswerDeps {
  return { clipboard, ClipboardItem, Blob: fakeBlob };
}

describe("copyLatestAnswer", () => {
  it("uses the server answer callback and copies its exact text with writeText", async () => {
    const fetchAnswer = vi.fn(async () => answer("only the authoritative answer"));
    const writeText = vi.fn(async (_text: string) => {});

    expect(
      await copyLatestAnswer(fetchAnswer, deps({ writeText })),
    ).toBe("copied");
    expect(fetchAnswer).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("only the authoritative answer");
  });

  it("calls ClipboardItem write synchronously and resolves its promised Blob", async () => {
    let resolveAnswer!: (value: PaneAnswerResponse) => void;
    const answerPromise = new Promise<PaneAnswerResponse>((resolve) => {
      resolveAnswer = resolve;
    });
    let item: FakeClipboardItem | undefined;
    const write = vi.fn(async (items: ClipboardItem[]) => {
      const captured = items[0] as unknown as FakeClipboardItem;
      item = captured;
      await captured.data["text/plain"];
    });

    const result = copyLatestAnswer(() => answerPromise, deps({ write }, fakeClipboardItem));

    expect(write).toHaveBeenCalledTimes(1);
    expect(item).toBeDefined();

    resolveAnswer(answer("mobile Safari answer"));
    expect(await result).toBe("copied");
    const blob = (await item!.data["text/plain"]) as Blob;
    expect(await blob.text()).toBe("mobile Safari answer");
    expect(blob.type).toBe("text/plain");
  });
  it("does not write content for an unavailable answer on the ClipboardItem path", async () => {
    let payload: unknown;
    const write = vi.fn(async (items: ClipboardItem[]) => {
      const item = items[0] as unknown as FakeClipboardItem;
      payload = item.data["text/plain"];
      await payload;
    });

    const result = await copyLatestAnswer(
      async () => unavailable(),
      deps({ write }, fakeClipboardItem),
    );

    expect(result).toBe("empty");
    await expect(payload as Promise<unknown>).rejects.toBeDefined();
  });

  it("maps an unavailable answer to empty without calling writeText", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    const result = await copyLatestAnswer(
      async () => unavailable(),
      deps({ writeText }),
    );

    expect(result).toBe("empty");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("maps a blank available answer to empty without calling writeText", async () => {
    const writeText = vi.fn(async (_text: string) => {});

    expect(
      await copyLatestAnswer(
        async () => answer(" \n\t"),
        deps({ writeText }),
      ),
    ).toBe("empty");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to writeText when ClipboardItem/write is unavailable", async () => {
    const writeText = vi.fn(async (_text: string) => {});

    expect(
      await copyLatestAnswer(
        async () => answer("fallback answer"),
        deps({ writeText }, undefined),
      ),
    ).toBe("copied");
    expect(writeText).toHaveBeenCalledWith("fallback answer");
  });

  it("reports unsupported when both clipboard write methods are unavailable", async () => {
    expect(
      await copyLatestAnswer(
        async () => answer(),
        deps({}, undefined),
      ),
    ).toBe("unsupported");
  });

  it("maps fetch and permission failures to failed", async () => {
    const writeText = vi.fn(async (_text: string) => {
      throw new Error("permission denied");
    });

    await expect(
      copyLatestAnswer(
        async () => {
          throw new Error("network unavailable");
        },
        deps({ writeText }, undefined),
      ),
    ).resolves.toBe("failed");

    await expect(
      copyLatestAnswer(async () => answer(), deps({ writeText }, undefined)),
    ).resolves.toBe("failed");
  });

});
