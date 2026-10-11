// Side-effect-free shared line diff; host behavior is unchanged.
export interface DiffLine {
  type: "context" | "add" | "remove";
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
}

// An empty string has ZERO lines, not one blank line -- `"".split("\n")` disagrees (`[""]`), which
// would inject a spurious leading "remove the empty line" artifact into every diff against a brand
// new (previousContent === "") or fully-emptied file. Any NON-empty string still splits normally,
// correctly preserving a genuine trailing "" element for content that ends in a newline.
function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const m = oldLines.length;
  const n = newLines.length;

  // dp[i][j] = length of the LCS of oldLines[i..] and newLines[j..].
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const dpRowBelow = dp[i + 1]!;
      const dpRow = dp[i]!;
      dpRow[j] = oldLines[i] === newLines[j] ? dpRowBelow[j + 1]! + 1 : Math.max(dpRowBelow[j]!, dpRow[j + 1]!);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldLineNumber = 1;
  let newLineNumber = 1;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: "context", oldLineNumber, newLineNumber, content: oldLines[i]! });
      i++;
      j++;
      oldLineNumber++;
      newLineNumber++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      result.push({ type: "remove", oldLineNumber, content: oldLines[i]! });
      i++;
      oldLineNumber++;
    } else {
      result.push({ type: "add", newLineNumber, content: newLines[j]! });
      j++;
      newLineNumber++;
    }
  }
  while (i < m) {
    result.push({ type: "remove", oldLineNumber, content: oldLines[i]! });
    i++;
    oldLineNumber++;
  }
  while (j < n) {
    result.push({ type: "add", newLineNumber, content: newLines[j]! });
    j++;
    newLineNumber++;
  }
  return result;
}
