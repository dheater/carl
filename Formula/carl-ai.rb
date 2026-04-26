class CarlAi < Formula
  desc "Opinionated AI development workflow"
  homepage "https://github.com/dheater/carl"
  url "https://github.com/dheater/carl/releases/download/v0.0.0/carl.js"
  version "0.0.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
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
