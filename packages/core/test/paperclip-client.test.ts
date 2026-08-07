import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpPaperclipClient, NotImplementedError, PaperclipApiError } from "../src/paperclip-client.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(fixturesDir, name), "utf8"));
}

/**
 * Contract tests: assert HttpPaperclipClient calls the exact endpoints and
 * auth header documented in docs/paperclip-api.md, and correctly maps
 * recorded (fixture) response bodies from Paperclip's real API surface. If
 * upstream changes shape, these fixtures should be the first thing that
 * fails, in one file, instead of a surprise deep in transport/UI code.
 */
describe("HttpPaperclipClient (contract)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  function makeClient() {
    return new HttpPaperclipClient({
      baseUrl: "https://paperclip.example/api",
      apiKey: "scoped-agent-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
  }

  function jsonResponse(body: unknown, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }

  it("GET /issues/:id sends the bearer token and maps the fixture body", async () => {
    const fixture = await loadFixture("issue.json");
    fetchMock.mockResolvedValueOnce(jsonResponse(fixture));

    const client = makeClient();
    const issue = await client.getIssue("issue-123");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://paperclip.example/api/issues/issue-123",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer scoped-agent-key" }),
      }),
    );
    expect(issue).toEqual(fixture);
  });

  it("GET /issues/:id returns null on 404 instead of throwing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Issue not found" }, 404));
    const client = makeClient();
    await expect(client.getIssue("missing")).resolves.toBeNull();
  });

  it("POST /issues/:id/comments sends body+resume and maps the created comment", async () => {
    const fixture = await loadFixture("comment.json");
    fetchMock.mockResolvedValueOnce(jsonResponse(fixture));

    const client = makeClient();
    const comment = await client.postComment({ issueId: "issue-123", body: "hello agent", resume: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://paperclip.example/api/issues/issue-123/comments",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ body: "hello agent", resume: true }),
      }),
    );
    expect(comment).toEqual(fixture);
  });

  it("GET /issues/:id/comments maps a list of recorded comments", async () => {
    const fixture = await loadFixture("comments-list.json");
    fetchMock.mockResolvedValueOnce(jsonResponse(fixture));

    const client = makeClient();
    const comments = await client.listComments("issue-123");

    expect(comments).toEqual(fixture);
  });

  it("GET /issues/:issueId/active-run maps a recorded active run", async () => {
    const fixture = await loadFixture("active-run.json");
    fetchMock.mockResolvedValueOnce(jsonResponse(fixture));

    const client = makeClient();
    const run = await client.getActiveRun("issue-123");

    expect(run).toEqual(fixture);
  });

  it("GET /issues/:issueId/active-run returns null on 404 instead of throwing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "not found" }, 404));
    const client = makeClient();
    await expect(client.getActiveRun("issue-123")).resolves.toBeNull();
  });

  it("throws PaperclipApiError with status and body on non-2xx, non-404 responses", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "nope" }, 500));
    const client = makeClient();
    await expect(client.postComment({ issueId: "issue-123", body: "x" })).rejects.toThrow(PaperclipApiError);
  });

  it("createConversationIssue is an explicit, documented gap in v1", async () => {
    const client = makeClient();
    await expect(client.createConversationIssue({ agentId: "a", title: "t" })).rejects.toThrow(NotImplementedError);
  });

  describe("runtime response validation (zod at the boundary)", () => {
    it("rejects a 200 response that doesn't match the documented issue shape instead of returning a garbage object", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: "issue-1" /* missing everything else */ }));
      const client = makeClient();
      await expect(client.getIssue("issue-1")).rejects.toThrow(PaperclipApiError);
    });

    it("rejects a comment list response where an element drifted shape (e.g. a field renamed upstream)", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([{ id: "c1", text: "renamed from body", authorType: "user", createdAt: "2026-01-01T00:00:00Z" }]),
      );
      const client = makeClient();
      await expect(client.listComments("issue-1")).rejects.toThrow(PaperclipApiError);
    });

    it("accepts a well-formed active-run response of null (no active run) without validation errors", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(null));
      const client = makeClient();
      await expect(client.getActiveRun("issue-1")).resolves.toBeNull();
    });
  });
});
