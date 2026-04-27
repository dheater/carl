class CarlAi < Formula
  desc "Opinionated AI development workflow"
  homepage "https://github.com/dheater/carl"
  url "https://github.com/dheater/carl/releases/download/v5.2.11/carl.js"
  version "5.2.11"
  sha256 "7cc55c37c05e41cbbe8861921d2628ad8099df9e1f4fc82148e95d10258fb925"
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
