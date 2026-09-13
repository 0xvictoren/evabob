/**
 * Live-evaluate a soft arithmetic expression as the user types.
 * Supports +, −, *, / (and × ÷). Returns partial display + resolved value when ready.
 */
export type CalcState = {
  expression: string;
  display: string;
  value: number | null;
  error: boolean;
};

const OPERATORS = new Set(["+", "-", "*", "/", "×", "÷", "−"]);

function normalizeOp(ch: string) {
  if (ch === "×") return "*";
  if (ch === "÷") return "/";
  if (ch === "−") return "-";
  return ch;
}

function tokenize(expr: string): string[] {
  const tokens: string[] = [];
  let num = "";
  for (const raw of expr) {
    const ch = normalizeOp(raw);
    if (/[0-9.]/.test(ch)) {
      num += ch;
    } else if (OPERATORS.has(ch) || OPERATORS.has(raw)) {
      if (num) {
        tokens.push(num);
        num = "";
      }
      // unary minus at start or after operator
      if (
        (ch === "-" || ch === "−") &&
        (tokens.length === 0 || OPERATORS.has(normalizeOp(tokens[tokens.length - 1])))
      ) {
        num = "-";
      } else {
        tokens.push(ch === "−" ? "-" : ch);
      }
    }
  }
  if (num) tokens.push(num);
  return tokens;
}

function safeEval(tokens: string[]): number | null {
  if (tokens.length === 0) return null;
  // Only complete binary ops: n op n [op n ...]
  const nums: number[] = [];
  const ops: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (OPERATORS.has(t) || t === "*" || t === "/") {
      ops.push(t);
    } else {
      const n = Number(t);
      if (Number.isNaN(n)) return null;
      nums.push(n);
    }
  }

  // Incomplete trailing operator
  if (ops.length >= nums.length) return null;
  if (nums.length === 0) return null;
  if (nums.length === 1 && ops.length === 0) return nums[0];

  // Left-to-right with * / precedence
  const values = [...nums];
  const operators = [...ops];

  // First pass: * /
  let i = 0;
  while (i < operators.length) {
    if (operators[i] === "*" || operators[i] === "/") {
      const a = values[i];
      const b = values[i + 1];
      if (operators[i] === "/" && b === 0) return null;
      const r = operators[i] === "*" ? a * b : a / b;
      values.splice(i, 2, r);
      operators.splice(i, 1);
    } else {
      i++;
    }
  }

  // Second pass: + -
  let result = values[0];
  for (let j = 0; j < operators.length; j++) {
    const op = operators[j];
    const b = values[j + 1];
    if (op === "+") result += b;
    else if (op === "-") result -= b;
  }
  return result;
}

export function emptyCalc(): CalcState {
  return { expression: "", display: "0", value: 0, error: false };
}

export function applyKey(state: CalcState, key: string): CalcState {
  let expr = state.expression;

  if (key === "C") {
    return emptyCalc();
  }

  if (key === "⌫") {
    expr = expr.slice(0, -1);
  } else if (key === "=") {
    const tokens = tokenize(expr);
    const value = safeEval(tokens);
    if (value === null) return { ...state, error: true };
    const rounded = Math.round(value * 100) / 100;
    return {
      expression: String(rounded),
      display: formatDisplay(rounded),
      value: rounded,
      error: false,
    };
  } else if (key === ".") {
    // only one decimal in current number segment
    const parts = expr.split(/[+\-*/×÷−]/);
    const last = parts[parts.length - 1] ?? "";
    if (last.includes(".")) return state;
    if (!expr || OPERATORS.has(normalizeOp(expr.slice(-1)))) {
      expr += "0.";
    } else {
      expr += ".";
    }
  } else {
    // digits and operators
    const isOp = OPERATORS.has(key) || ["+", "-", "*", "/", "×", "÷", "−"].includes(key);
    if (isOp) {
      if (!expr) return state;
      const last = expr.slice(-1);
      if (OPERATORS.has(normalizeOp(last))) {
        expr = expr.slice(0, -1) + key;
      } else {
        expr += key;
      }
    } else {
      // digit
      if (expr === "0") expr = key;
      else expr += key;
    }
  }

  const tokens = tokenize(expr);
  const value = safeEval(tokens);
  const lastIsOp =
    expr.length > 0 && OPERATORS.has(normalizeOp(expr.slice(-1)));

  // Prefer live resolved value when expression is complete; else show expression
  let display: string;
  if (value !== null && !lastIsOp) {
    display = formatDisplay(value);
  } else if (!expr) {
    display = "0";
  } else {
    display = expr.replace(/\*/g, "×").replace(/\//g, "÷");
  }

  return {
    expression: expr,
    display,
    value: value !== null && !lastIsOp ? Math.round(value * 100) / 100 : null,
    error: false,
  };
}

function formatDisplay(n: number) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}
