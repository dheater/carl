import * as fs from "fs";
import * as path from "path";

export function loadSkillContent(skillName: string): string {
  const skillPath = path.join(__dirname, "..", "skills", `${skillName}.md`);
  return fs.readFileSync(skillPath, "utf-8");
}
