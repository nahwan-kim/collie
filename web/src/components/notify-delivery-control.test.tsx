import { beforeEach, describe, expect, test } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { NotifyDeliveryControl } from "@/components/notify-delivery-control";
import { useNotifyPrefs } from "@/hooks/use-notify-prefs";
import { server } from "@/test/setup";

type NotifyPrefsFixture = {
  blocked: boolean;
  done: boolean;
  updates: boolean;
  preview: "hidden" | "blocked" | "all";
  mode: "summary" | "per-task";
  layout: "task-first" | "context-first" | "compact";
};

let currentPrefs: NotifyPrefsFixture;
let lastPatch: Record<string, unknown> | undefined;

function deferred() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, resolve: () => release?.() };
}

function UpdateHarness() {
  const { prefs, busy, update } = useNotifyPrefs();
  return (
    <>
      <button type="button" onClick={() => void update({ preview: "all", mode: "per-task" })}>
        Apply both
      </button>
      <output data-testid="snapshot">{prefs ? JSON.stringify(prefs) : "loading"}</output>
      <span data-testid="busy">{busy ? "busy" : "idle"}</span>
    </>
  );
}

beforeEach(() => {
  lastPatch = undefined;
  currentPrefs = {
    blocked: true,
    done: false,
    updates: true,
    preview: "hidden",
    mode: "summary",
    layout: "task-first",
  };
  server.use(
    http.get("/api/notifications/prefs", () => HttpResponse.json(currentPrefs)),
    http.post("/api/notifications/prefs", async ({ request }) => {
      lastPatch = (await request.json()) as Record<string, unknown>;
      currentPrefs = { ...currentPrefs, ...(lastPatch as Partial<NotifyPrefsFixture>) };
      return HttpResponse.json(currentPrefs);
    }),
  );
});

describe("NotifyDeliveryControl", () => {
  test("renders safe defaults, labelled sections, and explicit scope copy", async () => {
    render(<NotifyDeliveryControl />);

    expect(await screen.findByRole("button", { name: "Work only" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Questions" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Questions & answers" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("switch", { name: "Separate task notifications" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Task first" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("heading", { name: "Privacy" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Delivery mode" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Layout" })).toBeInTheDocument();
    expect(screen.getByText("No conversation content.")).toBeInTheDocument();
    expect(screen.getByText("Blocked questions only.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Warning: conversation content appears on every device lock screen and in history.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Bridge-wide settings apply to all devices.")).toBeInTheDocument();
  });

  test("POSTs an exact single-key patch for every enum value", async () => {
    const user = userEvent.setup();
    render(<NotifyDeliveryControl />);

    const privacy = [
      ["Work only", { preview: "hidden" }],
      ["Questions", { preview: "blocked" }],
      ["Questions & answers", { preview: "all" }],
    ] as const;
    const layouts = [
      ["Task first", { layout: "task-first" }],
      ["Context first", { layout: "context-first" }],
      ["Compact", { layout: "compact" }],
    ] as const;

    for (const [label, patch] of [...privacy, ...layouts]) {
      const button = screen.getByRole("button", { name: label });
      await waitFor(() => expect(button).not.toBeDisabled());
      await user.click(button);
      await waitFor(() => expect(lastPatch).toEqual(patch));
    }
  });

  test("updates optimistically, then lets the complete server response win", async () => {
    const user = userEvent.setup();
    const post = deferred();
    server.use(
      http.post("/api/notifications/prefs", async ({ request }) => {
        lastPatch = (await request.json()) as Record<string, unknown>;
        await post.promise;
        return HttpResponse.json({ ...currentPrefs, preview: "blocked" });
      }),
    );
    render(<NotifyDeliveryControl />);

    const all = await screen.findByRole("button", { name: "Questions & answers" });
    await user.click(all);
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(all).toBeDisabled();
    expect(lastPatch).toEqual({ preview: "all" });

    post.resolve();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Questions" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(all).toHaveAttribute("aria-pressed", "false");
  });

  test("rolls back the complete previous snapshot when a multi-key patch fails", async () => {
    const user = userEvent.setup();
    const post = deferred();
    server.use(
      http.post("/api/notifications/prefs", async () => {
        await post.promise;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    render(<UpdateHarness />);

    const before = JSON.stringify(currentPrefs);
    const apply = await screen.findByRole("button", { name: "Apply both" });
    await user.click(apply);
    expect(screen.getByTestId("snapshot")).toHaveTextContent('"preview":"all"');
    expect(screen.getByTestId("snapshot")).toHaveTextContent('"mode":"per-task"');

    post.resolve();
    await waitFor(() => expect(screen.getByTestId("snapshot")).toHaveTextContent(before));
    expect(screen.getByTestId("busy")).toHaveTextContent("idle");
  });

  test("keeps the complete card shape while loading and disables every control", async () => {
    const gate = deferred();
    server.use(
      http.get("/api/notifications/prefs", async () => {
        await gate.promise;
        return HttpResponse.json(currentPrefs);
      }),
    );
    render(<NotifyDeliveryControl />);

    for (const label of ["Work only", "Questions", "Questions & answers", "Task first", "Context first", "Compact"]) {
      expect(screen.getByRole("button", { name: label })).toBeDisabled();
    }
    expect(screen.getByRole("switch", { name: "Separate task notifications" })).toBeDisabled();
    expect(screen.getByRole("heading", { name: "Privacy" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Delivery mode" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Layout" })).toBeInTheDocument();

    gate.resolve();
    await waitFor(() => expect(screen.getByRole("button", { name: "Work only" })).not.toBeDisabled());
  });

  test("maps the delivery switch to summary and per-task exactly", async () => {
    const user = userEvent.setup();
    render(<NotifyDeliveryControl />);
    const separate = await screen.findByRole("switch", { name: "Separate task notifications" });

    await user.click(separate);
    await waitFor(() => expect(lastPatch).toEqual({ mode: "per-task" }));
    await waitFor(() => expect(separate).toBeChecked());

    await user.click(separate);
    await waitFor(() => expect(lastPatch).toEqual({ mode: "summary" }));
    await waitFor(() => expect(separate).not.toBeChecked());
  });

  test("uses accessible pressed buttons with mobile-sized touch rows", async () => {
    render(<NotifyDeliveryControl />);

    const privacy = await screen.findByRole("group", { name: "Privacy" });
    const layout = screen.getByRole("group", { name: "Layout" });
    expect(privacy).toBeInTheDocument();
    expect(layout).toBeInTheDocument();
    for (const button of [
      ...privacy.querySelectorAll("button"),
      ...layout.querySelectorAll("button"),
    ]) {
      expect(button).toHaveAttribute("aria-pressed");
      expect(button).toHaveClass("min-h-11");
    }
  });
});
