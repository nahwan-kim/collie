import { describe, expect, test } from "bun:test";

import { summarizeToolInput } from "./text.ts";

describe("summarizeToolInput — AskUserQuestion", () => {
  test("extracts nested questions and choice labels in order", () => {
    expect(
      summarizeToolInput({
        questions: [
          {
            question: "Which layout should we use?",
            options: [
              { label: "Grid", description: "Cards in rows" },
              { label: "List", description: "One card per line" },
            ],
          },
          {
            question: "Enable dark mode?",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
      }),
    ).toBe("Which layout should we use? (Grid, List); Enable dark mode? (Yes, No)");
  });

  test("drops blank questions and blank choice labels without disturbing order", () => {
    expect(
      summarizeToolInput({
        questions: [
          { question: "   ", options: [{ label: "ignored" }] },
          { question: "Pick a color", options: [{ label: " Red " }, { label: "  " }, null] },
          "not a question",
          { question: "No choices", options: [{ description: "not visible" }] },
        ],
      }),
    ).toBe("Pick a color (Red); No choices");
  });

  test("keeps existing defining-argument priority over a questions array", () => {
    expect(
      summarizeToolInput({
        file_path: "/repo/README.md",
        questions: [{ question: "This must not replace the file path" }],
      }),
    ).toBe("/repo/README.md");
  });

  test("applies the existing one-line 200-character cap to the question summary", () => {
    const summary = summarizeToolInput({
      questions: [{ question: "x".repeat(500), options: [{ label: "yes" }] }],
    });
    expect(summary).toHaveLength(201);
    expect(summary.endsWith("…")).toBe(true);
  });

  test("bounds question and option arrays before flattening", () => {
    expect(
      summarizeToolInput({
        questions: Array.from({ length: 10 }, (_, index) => ({ question: `Q${index}` })),
      }),
    ).toBe("Q0; Q1; Q2; Q3; …");

    expect(
      summarizeToolInput({
        questions: [
          {
            question: "Pick",
            options: Array.from({ length: 10 }, (_, index) => ({ label: `O${index}` })),
          },
        ],
      }),
    ).toBe("Pick (O0, O1, O2, O3, O4, O5, …)");
  });

  test("stops scanning an array made from malformed entries", () => {
    expect(
      summarizeToolInput({
        questions: [...Array.from({ length: 40 }, () => null), { question: "too late" }],
      }),
    ).toBe("…");
  });
});
