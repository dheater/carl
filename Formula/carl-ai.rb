class CarlAi < Formula
  desc "Opinionated AI development workflow"
  homepage "https://github.com/dheater/carl"
  url "https://github.com/dheater/carl/releases/download/v5.2.4/carl.js"
  version "5.2.4"
  sha256 "7d7f6e832d33b0294055ef1cfa4d00073f837f6b893f98715721cd96971a05bb"
  license "MIT"

  depends_on "node"

  def install
    libexec.install "carl.js"
    (bin/"carl").write <<~EOS
      #!/bin/bash
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/carl.js" "$@"
    EOS
  end

  def test
    system "#{bin}/carl", "status"
  end
end
