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
      expect(result).toEqual({ action: "approve" });
    });

    test("recognize 'APPROVE' (uppercase) as approval", () => {
      const result = parseEditorGateApproval(
        "# comment\nAPPROVE",
        baseTemplate,
      );
      expect(result).toEqual({ action: "approve" });
    });

    test("recognize 'Approved' (mixed case) as approval", () => {
      const result = parseEditorGateApproval(
        "# comment\nApproved",
        baseTemplate,
      );
      expect(result).toEqual({ action: "approve" });
    });

    test("recognize '  approve  ' (surrounded by whitespace) as approval", () => {
      const result = parseEditorGateApproval(
        "# comment\n  approve  ",
        baseTemplate,
      );
      expect(result).toEqual({ action: "approve" });
    });

    test("recognize '  APPROVED  ' (uppercase with whitespace) as approval", () => {
      const result = parseEditorGateApproval(
        "# comment\n  APPROVED  ",
        baseTemplate,
      );
      expect(result).toEqual({ action: "approve" });
    });

    test("recognize 'approve: some notes' as approval (backward compat)", () => {
      const result = parseEditorGateApproval(
        "# comment\napprove: looks good",
        baseTemplate,
      );
      expect(result).toEqual({ action: "approve" });
    });

    test("recognize '  approved: notes  ' with whitespace as approval", () => {
      const result = parseEditorGateApproval(
        "# comment\n  approved: looks good  ",
        baseTemplate,
      );
      expect(result).toEqual({ action: "approve" });
    });
  });

  describe("existing approval behavior", () => {
    test("empty body (all deleted) still approves", () => {
      const result = parseEditorGateApproval("", baseTemplate);
      expect(result).toEqual({ action: "approve" });
    });

    test("unchanged template content still approves", () => {
      const result = parseEditorGateApproval(baseTemplate, baseTemplate);
      expect(result).toEqual({ action: "approve" });
    });

    test("unchanged template with extra comments still approves", () => {
      const withComments =
        "# [architect] is waiting for your input\n# Some agent output here\n# extra comment";
      const result = parseEditorGateApproval(withComments, baseTemplate);
      expect(result).toEqual({ action: "approve" });
    });
  });

  describe("reject behavior", () => {
    test("recognize 'reject: reason' as rejection", () => {
      const result = parseEditorGateApproval(
        "# comment\nreject: needs more work",
        baseTemplate,
      );
      expect(result).toEqual({
        action: "reject",
        reason: "needs more work",
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
