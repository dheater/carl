class CarlAi < Formula
  desc "Opinionated AI development workflow"
  homepage "https://github.com/dheater/carl"
  url "https://github.com/dheater/carl/archive/refs/tags/v5.2.2.tar.gz"
  version "5.2.2"
  sha256 "a40872edb970507f61cb795fd8a2ea8c9b91675518c034cb85f388a9358a4936"
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
