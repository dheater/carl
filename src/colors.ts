const useColor =
  !process.env.NO_COLOR && (process.stdout.isTTY || process.stderr.isTTY);

const wrap = (code: string) => (s: string) =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;

export const red = wrap("31");
export const yellow = wrap("33");
export const blue = wrap("34");
