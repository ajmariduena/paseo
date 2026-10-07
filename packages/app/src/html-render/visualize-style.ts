import type { RenderTheme } from "./document";

const NAMED_COLORS = {
  light: {
    "--blue": "#2563eb",
    "--orange": "#d97706",
    "--green": "#16a34a",
    "--red": "#dc2626",
    "--purple": "#9333ea",
    "--yellow": "#ca8a04",
  },
  dark: {
    "--blue": "#60a5fa",
    "--orange": "#fb923c",
    "--green": "#4ade80",
    "--red": "#f87171",
    "--purple": "#c084fc",
    "--yellow": "#facc15",
  },
} as const;

export function visualizationVariables(theme: RenderTheme): Record<string, string> {
  const variables: Record<string, string> = {
    ...theme.variables,
    ...NAMED_COLORS[theme.appearance],
  };
  for (let index = 1; index <= 6; index += 1) {
    variables[`--viz-series-${index}`] =
      index === 1 ? variables["--primary"] : variables[`--chart-${index}`];
  }
  return variables;
}

export function visualizationThemeCss(theme: RenderTheme): string {
  const declarations = Object.entries(visualizationVariables(theme))
    .map(([name, value]) => `${name}:${value.replace(/[;{}<>]/g, "")}`)
    .join(";");
  return `:root{color-scheme:${theme.appearance};${declarations}}`;
}

export const VISUALIZATION_BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{background:transparent;color:var(--foreground);font:var(--font-size-base,14px)/1.5 var(--font-sans,system-ui);-webkit-font-smoothing:antialiased}
body{margin:0;min-width:0;background:transparent}button,input,select,textarea{font:inherit}button{cursor:pointer}
:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
a{color:var(--primary)}hr{border:0;border-top:1px solid var(--border);margin:1rem 0}
.card,.widget{background:var(--card);color:var(--card-foreground);border:1px solid var(--border);border-radius:var(--radius);padding:1rem}
.viz-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:.75rem}
.viz-row,.viz-controls{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}
.viz-stat{min-width:0}.viz-stat-value{font-size:1.55em;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums}
.viz-badge{display:inline-flex;align-items:center;background:var(--secondary);color:var(--secondary-foreground);border-radius:999px;padding:.15em .6em;font-size:.8em}
.viz-tile{width:100%;min-height:44px}.viz-tile[aria-pressed=true],.viz-tile.active{outline:2px solid var(--ring)}
.progress{height:.5rem;border-radius:999px;background:var(--muted);overflow:hidden}.progress-bar{height:100%;background:var(--primary);border-radius:inherit}
.nav{display:flex;flex-wrap:wrap;gap:.25rem}.nav-justified>*{flex:1}.nav-link{border:0;background:transparent;color:var(--muted-foreground);border-radius:var(--radius);padding:.4rem .7rem;min-height:32px}
.nav-link.active,.nav-link[aria-selected=true]{background:var(--secondary);color:var(--secondary-foreground)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.35rem;min-height:32px;padding:.35rem .7rem;border:1px solid var(--border);border-radius:var(--radius);background:transparent;color:var(--foreground)}
.btn-primary{background:var(--foreground);color:var(--background);border-color:var(--foreground)}.btn-ghost{border-color:transparent}.btn-block{width:100%}
.cursor-interaction{cursor:pointer}.form-label{display:grid;gap:.3rem;color:var(--foreground)}
.form-control,.form-select{width:100%;min-height:36px;padding:.4rem .6rem;border:1px solid var(--input);border-radius:var(--radius);background:var(--background);color:var(--foreground)}
.form-control-color{width:44px;min-height:36px;padding:.2rem}.form-range{width:100%;accent-color:var(--primary)}
.form-check{display:inline-flex;align-items:center;gap:.4rem}.form-check-input{accent-color:var(--primary)}.form-switch .form-check-input{width:2rem}
.table-responsive{max-width:100%;overflow-x:auto}.table{width:100%;border-collapse:collapse;text-align:left}.table th,.table td{padding:.45rem .55rem;border-bottom:1px solid var(--border)}
.table thead th{color:var(--muted-foreground);font-weight:600}.table-sm th,.table-sm td{padding:.28rem .4rem}
.text-small{font-size:max(11px,calc(var(--font-size-base,14px) * .857))}.text-muted{color:var(--muted-foreground)}.text-destructive{color:var(--destructive)}
.text-warning{color:var(--orange)}.text-end{text-align:right}.text-center{text-align:center}.text-nowrap{white-space:nowrap}.tabular-nums{font-variant-numeric:tabular-nums}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.viz-dotted-background{background-image:radial-gradient(var(--border) 1px,transparent 1px);background-size:16px 16px}
.viz-carousel [data-variant][hidden],[role=tabpanel][hidden]{display:none!important}
.paseo-viz-tooltip{position:fixed;z-index:10;max-width:260px;padding:.3rem .5rem;border-radius:var(--radius);background:var(--foreground);color:var(--background);font-size:12px;pointer-events:none}
@media(max-width:480px){.viz-grid{grid-template-columns:1fr}.table th,.table td{white-space:normal}.btn,.nav-link{min-height:44px}.form-control,.form-select{min-height:44px;font-size:16px}}
`;
