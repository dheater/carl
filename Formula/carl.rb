class Carl < Formula
  desc "Opinionated AI development workflow"
  homepage "https://github.com/dheater/carl"
  url "https://github.com/dheater/carl/archive/refs/tags/v5.2.1.tar.gz"
  version "5.2.1"
  sha256 "998501befbc12580eff4d0c572692543ee40306c5884518541a6edacd6c70593"
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
