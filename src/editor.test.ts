import { parseEditorGateApproval, EditorAction } from "./editor";

describe("parseEditorGateApproval", () => {
  const baseTemplate = `# [architect] is waiting for your input
# Some agent output here`;

  describe("approve/approved with optional whitespace", () => {
    test("recognize 'approve' as approval", () => {
      const result = parseEditorGateApproval(
        "# comment\napprove",
        baseTemplate,
      );
      expect(result).toEqual({ action: "approve", fullBuffer: "approve" });
    });

    test("recognize 'APPROVE' (uppercase) as approval", () => {
      const result = parseEditorGateApproval(
        "# comment\nAPPROVE",
        baseTemplate,
      );
      expect(result).toEqual({ action: "approve", fullBuffer: "APPROVE" });
    });

    test("recognize 'Approved' (mixed case) as approval", () => {
      const result = parseEditorGateApproval(
        "# comment\nApproved",
        baseTemplate,
      );
      expect(result).toEqual({ action: "approve", fullBuffer: "Approved" });
    });

    test("recognize '  approve  ' (surrounded by whitespace) as approval", () => {
      const result = parseEditorGateApproval(
        "# comment\n  approve  ",
        baseTemplate,
      );
      expect(result).toEqual({ action: "approve", fullBuffer: "approve" });
    });

    test("recognize '  APPROVED  ' (uppercase with whitespace) as approval", () => {
      const result = parseEditorGateApproval(
        "# comment\n  APPROVED  ",
        baseTemplate,
      );
      expect(result).toEqual({ action: "approve", fullBuffer: "APPROVED" });
    });

    test("recognize 'approve: some notes' as approval (backward compat)", () => {
      const result = parseEditorGateApproval(
        "# comment\napprove: looks good",
        baseTemplate,
      );
      expect(result).toEqual({
        action: "approve",
        fullBuffer: "approve: looks good",
      });
    });

    test("recognize '  approved: notes  ' with whitespace as approval", () => {
      const result = parseEditorGateApproval(
        "# comment\n  approved: looks good  ",
        baseTemplate,
      );
      expect(result).toEqual({
        action: "approve",
        fullBuffer: "approved: looks good",
      });
    });
  });

  describe("existing approval behavior", () => {
    test("empty body (all deleted) still approves", () => {
      const result = parseEditorGateApproval("", baseTemplate);
      expect(result).toEqual({ action: "approve", fullBuffer: "" });
    });

    test("unchanged template content still approves", () => {
      const result = parseEditorGateApproval(baseTemplate, baseTemplate);
      expect(result).toEqual({ action: "approve", fullBuffer: "" });
    });

    test("unchanged non-comment agent output is preserved in approval buffer", () => {
      const template = `# [architect] is waiting for your input\n\n## Question\n\nUse repo root?`;
      const result = parseEditorGateApproval(template, template);
      expect(result).toEqual({
        action: "approve",
        fullBuffer: "## Question\n\nUse repo root?",
      });
    });

    test("unchanged template with extra comments still approves", () => {
      const withComments =
        "# [architect] is waiting for your input\n# Some agent output here\n# extra comment";
      const result = parseEditorGateApproval(withComments, baseTemplate);
      expect(result).toEqual({ action: "approve", fullBuffer: "" });
    });
  });

  describe("reject behavior", () => {
    test("t-8: preserve full editor buffer on rejection", () => {
      const reviewerOutput = `## Validation

You asked for: Login flow

## Subtraction and cleanup

- **[Security]: Missing password hash verification** — Add bcrypt validation

reject: missing security checks`;

      const editorContent = `# [reviewer] is waiting
# Some header
${reviewerOutput}`;

      const result = parseEditorGateApproval(editorContent, baseTemplate);
      expect(result.action).toBe("reject");
      if (result.action === "reject") {
        expect(result.reason).toBe("missing security checks");
        expect(result.fullBuffer).toBeDefined();
        // fullBuffer should have all non-comment lines, including the sections
        expect(result.fullBuffer).toContain("Login flow");
        expect(result.fullBuffer).toContain("Missing password hash");
        expect(result.fullBuffer).toContain("reject: missing security checks");
      }
    });

    test("recognize 'reject: reason' as rejection", () => {
      const result = parseEditorGateApproval(
        "# comment\nreject: needs more work",
        baseTemplate,
      );
      expect(result).toEqual({
        action: "reject",
        reason: "needs more work",
        fullBuffer: "reject: needs more work",
      });
    });

    test("recognize 'REJECT: REASON' (uppercase) as rejection", () => {
      const result = parseEditorGateApproval(
        "# comment\nREJECT: invalid approach",
        baseTemplate,
      );
      expect(result).toEqual({
        action: "reject",
        reason: "invalid approach",
        fullBuffer: "REJECT: invalid approach",
      });
    });

    test("recognize 'reject-architect: reason' with target phase", () => {
      const result = parseEditorGateApproval(
        "# comment\nreject-architect: rethink scope",
        baseTemplate,
      );
      expect(result).toEqual({
        action: "reject",
        reason: "rethink scope",
        target: "architect",
        fullBuffer: "reject-architect: rethink scope",
      });
    });
  });

  describe("reply behavior", () => {
    test("non-empty content that is not approve/reject returns reply", () => {
      const result = parseEditorGateApproval(
        "# comment\nSome feedback text here",
        baseTemplate,
      );
      expect(result).toEqual({
        action: "reply",
        message: expect.stringContaining("Some feedback text here"),
      });
    });

    test("added notes alongside template returns reply", () => {
      const result = parseEditorGateApproval(
        baseTemplate + "\nI have a question about X",
        baseTemplate,
      );
      expect(result).toEqual({
        action: "reply",
        message: expect.stringContaining("question about X"),
      });
    });
  });
});
