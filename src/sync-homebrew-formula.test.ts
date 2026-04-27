describe("sync-homebrew-formula", () => {
  describe("syncFormula", () => {
    // Test the formula sync logic inline since this is a simple utility
    const sampleFormula = `class CarlAi < Formula
  desc "Opinionated AI development workflow"
  homepage "https://github.com/dheater/carl"
  url "https://github.com/dheater/carl/releases/download/v5.0.0/carl.js"
  version "5.0.0"
  sha256 "abc123def456"
  license "MIT"

  depends_on "node"

  def install
    libexec.install "carl.js"
  end
end`;

    function syncFormula(
      content: string,
      version: string,
      url: string,
      sha256: string,
    ): string {
      content = content.replace(/^(\s*)url\s+"[^"]*"/m, `$1url "${url}"`);
      content = content.replace(
        /^(\s*)version\s+"[^"]*"/m,
        `$1version "${version}"`,
      );
      content = content.replace(
        /^(\s*)sha256\s+"[^"]*"/m,
        `$1sha256 "${sha256}"`,
      );
      return content;
    }

    it("should update version line", () => {
      const result = syncFormula(
        sampleFormula,
        "5.2.11",
        "https://github.com/dheater/carl/releases/download/v5.2.11/carl.js",
        "xyz789",
      );
      expect(result).toContain('version "5.2.11"');
    });

    it("should update url line", () => {
      const result = syncFormula(
        sampleFormula,
        "5.2.11",
        "https://github.com/dheater/carl/releases/download/v5.2.11/carl.js",
        "xyz789",
      );
      expect(result).toContain(
        'url "https://github.com/dheater/carl/releases/download/v5.2.11/carl.js"',
      );
    });

    it("should update sha256 line", () => {
      const result = syncFormula(
        sampleFormula,
        "5.2.11",
        "https://github.com/dheater/carl/releases/download/v5.2.11/carl.js",
        "xyz789",
      );
      expect(result).toContain('sha256 "xyz789"');
    });

    it("should update all three lines without changing other content", () => {
      const result = syncFormula(
        sampleFormula,
        "5.2.11",
        "https://github.com/dheater/carl/releases/download/v5.2.11/carl.js",
        "xyz789",
      );
      expect(result).toContain("class CarlAi < Formula");
      expect(result).toContain('desc "Opinionated AI development workflow"');
      expect(result).toContain('homepage "https://github.com/dheater/carl"');
      expect(result).toContain('license "MIT"');
      expect(result).toContain('depends_on "node"');
      expect(result).toContain("def install");
      expect(result).toContain('libexec.install "carl.js"');
      expect(result).toContain("end");
    });
  });
});
