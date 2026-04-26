class Carl < Formula
  desc "Opinionated AI development workflow"
  homepage "https://github.com/carl-lang/carl"
  url "https://github.com/carl-lang/carl/archive/refs/tags/v5.2.1.tar.gz"
  version "5.2.1"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *Language::Node.std_npm_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def test
    system "#{bin}/carl", "status"
  end
end
