import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Outlet, RouterProvider, createMemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { notificationHistoryLoader } from "@/lib/loaders";
import { clearStatus } from "@/lib/status";
import type { NotificationHistoryEntry } from "@/lib/types";
import { NotificationHistoryRoute } from "./notification-history";

const entries: NotificationHistoryEntry[] = [
  {
    id: "new-question",
    timestamp: new Date("2026-08-30T01:30:00.000Z").getTime(),
    paneId: "w1:p1",
    status: "blocked",
    work: "Choose the deployment target",
    context: "release",
    preview: "Production or staging?",
  },
  {
    id: "old-complete",
    timestamp: new Date("2026-08-29T01:30:00.000Z").getTime(),
    session: "collie-demo",
    paneId: "w2:p1",
    status: "done",
    work: "Review notification changes",
    context: "collie",
    resolvedAt: new Date("2026-08-29T01:35:00.000Z").getTime(),
  },
];

function makeRouter(initialPath = "/settings/notifications?s=collie-demo") {
  return createMemoryRouter(
    [
      {
        path: "/",
        element: <Outlet />,
        children: [
          {
            path: "settings/notifications",
            loader: notificationHistoryLoader,
            element: <NotificationHistoryRoute />,
          },
          { path: "settings", element: <div data-testid="settings">Settings</div> },
          {
            path: "pane/:paneId",
            element: (
              <div data-testid="pane">
                <LocationText />
              </div>
            ),
          },
        ],
      },
    ],
    { initialEntries: [initialPath] },
  );
}

function LocationText() {
  const location = useLocation();
  return `${location.pathname}${location.search}`;
}

function useHistoryResponse(rows: NotificationHistoryEntry[]) {
  server.use(
    http.get("/api/notifications/history", () => HttpResponse.json({ entries: rows })),
  );
}

function renderHistory(path?: string) {
  const router = makeRouter(path);
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => clearStatus());
afterEach(() => clearStatus());

describe("NotificationHistoryRoute", () => {
  it("renders newest-first rows with status, work, preview fallback, handled badge, timestamps, and ids", async () => {
    useHistoryResponse(entries);
    renderHistory();

    await screen.findByText("Choose the deployment target");
    const notificationRows = screen
      .getAllByRole("button")
      .filter((node) => node.hasAttribute("data-notification-id"));
    expect(notificationRows.map((row) => row.getAttribute("data-notification-id"))).toEqual([
      "new-question",
      "old-complete",
    ]);
    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("Choose the deployment target")).toBeInTheDocument();
    expect(screen.getByText("Production or staging?")).toBeInTheDocument();
    expect(screen.getByText("Review notification changes")).toBeInTheDocument();
    expect(screen.getByText("collie")).toBeInTheDocument();
    expect(screen.getByText("Handled")).toBeInTheDocument();
    expect(
      screen.getByText(
        new Date(entries[0]!.timestamp).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }),
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear notification history" })).toBeInTheDocument();
  });
  it("renders Unknown time for invalid and out-of-range timestamps without throwing", async () => {
    const rows: NotificationHistoryEntry[] = [
      { ...entries[0]!, id: "max-valid", timestamp: 8_640_000_000_000_000, work: "Max valid time" },
      { ...entries[0]!, id: "min-valid", timestamp: -8_640_000_000_000_000, work: "Min valid time" },
      { ...entries[0]!, id: "max-invalid", timestamp: 8_640_000_000_000_001, work: "Max invalid time" },
      { ...entries[0]!, id: "min-invalid", timestamp: -8_640_000_000_000_001, work: "Min invalid time" },
      { ...entries[0]!, id: "not-a-time", timestamp: Number.NaN, work: "NaN time" },
    ];
    useHistoryResponse(rows);
    renderHistory();

    expect(await screen.findByText("Max valid time")).toBeInTheDocument();
    expect(screen.getByText("Min valid time")).toBeInTheDocument();
    expect(screen.getAllByText("Unknown time")).toHaveLength(3);
  });

  it("opens a row in that entry's session and preserves the route session on Back", async () => {
    useHistoryResponse(entries);
    const router = renderHistory();

    const row = await screen.findByRole("button", { name: /Review notification changes/ });
    await userEvent.setup().click(row);
    expect(await screen.findByTestId("pane")).toHaveTextContent("/pane/w2%3Ap1?s=collie-demo");
    expect(router.state.location.pathname).toBe("/pane/w2%3Ap1");
    expect(router.state.location.search).toBe("?s=collie-demo");

    await router.navigate("/settings/notifications?s=collie-demo");
    await screen.findByRole("button", { name: /Choose the deployment target/ });
    await userEvent.setup().click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByTestId("settings")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings");
    expect(router.state.location.search).toBe("?s=collie-demo");
  });

  it("shows empty state and disables Clear when empty", async () => {
    useHistoryResponse([]);
    renderHistory();
    expect(await screen.findByText("No notifications yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear notification history" })).toBeDisabled();
  });

  it("shows the loader-failure state and disables Clear", async () => {
    server.use(http.get("/api/notifications/history", () => HttpResponse.error()));
    renderHistory("/settings/notifications");
    expect(await screen.findByText("Couldn't load notification history.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear notification history" })).toBeDisabled();
  });

  it("requires two taps, clears locally after DELETE, and reports success", async () => {
    useHistoryResponse(entries);
    let deletes = 0;
    server.use(
      http.delete("/api/notifications/history", () => {
        deletes += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderHistory();
    await screen.findByRole("button", { name: /Choose the deployment target/ });
    const user = userEvent.setup();
    const clear = screen.getByRole("button", { name: "Clear notification history" });

    await user.click(clear);
    expect(deletes).toBe(0);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Tap again to clear notification history",
    );
    expect(screen.getByRole("button", { name: /Choose the deployment target/ })).toBeInTheDocument();

    await user.click(clear);
    await waitFor(() => expect(deletes).toBe(1));
    expect(await screen.findByText("No notifications yet.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Notification history cleared");
    expect(clear).toBeDisabled();
  });

  it("keeps the list when clearing fails", async () => {
    useHistoryResponse(entries);
    server.use(
      http.delete("/api/notifications/history", () =>
        HttpResponse.json({ error: "unavailable" }, { status: 503 }),
      ),
    );
    renderHistory();
    await screen.findByRole("button", { name: /Choose the deployment target/ });
    const user = userEvent.setup();
    const clear = screen.getByRole("button", { name: "Clear notification history" });
    await user.click(clear);
    await user.click(clear);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Couldn't clear notification history"),
    );
    expect(screen.getByRole("button", { name: /Choose the deployment target/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Review notification changes/ })).toBeInTheDocument();
    expect(clear).not.toBeDisabled();
  });
});
