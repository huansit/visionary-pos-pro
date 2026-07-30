import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrintableReport } from "../components/reports/ReportEngine.jsx";
import printCss from "../styles/print.css?inline";

function safeName(name) {
  return String(name || "report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "report";
}

function reportHtml(report) {
  const markup = renderToStaticMarkup(React.createElement(PrintableReport, { report }));
  const orientation = report?.orientation === "landscape" ? "landscape" : "portrait";
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${String(report?.title || "Report").replace(/[<>&]/g, "")}</title>
  <style>${printCss}</style>
  <style>
    @page{size:A4 ${orientation};margin:12mm}
    html,body{margin:0;background:#fff;color:#111827}
  </style>
</head>
<body>
  <div id="print-root">${markup}</div>
</body>
</html>`;
}

function openPrintWindow(report) {
  const html = reportHtml(report);
  const win = window.open("", "_blank", "noopener,noreferrer,width=1100,height=800");
  if (!win) throw new Error("print_popup_blocked");
  win.document.open();
  win.document.write(html);
  win.document.close();
  return win;
}

export function previewReport(reportComponent) {
  return openPrintWindow(reportComponent);
}

export function printReport(reportComponent) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "1px";
  frame.style.height = "1px";
  frame.style.border = "0";
  frame.style.opacity = "0";
  frame.style.pointerEvents = "none";
  document.body.appendChild(frame);

  const printDocument = frame.contentDocument;
  const printWindow = frame.contentWindow;
  if (!printDocument || !printWindow) {
    frame.remove();
    throw new Error("print_frame_unavailable");
  }

  let printed = false;
  let cleanupTimer;
  const cleanup = () => {
    window.clearTimeout(cleanupTimer);
    window.setTimeout(() => frame.remove(), 250);
  };
  const run = async () => {
    if (printed) return;
    printed = true;
    const images = Array.from(printDocument.images || []);
    await Promise.all(images.map((image) => image.complete
      ? Promise.resolve()
      : new Promise((resolve) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", resolve, { once: true });
        })));
    if (printDocument.fonts?.ready) await printDocument.fonts.ready.catch(() => {});
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      try {
        printWindow.addEventListener("afterprint", cleanup, { once: true });
        printWindow.focus();
        printWindow.print();
      } catch (_) {
        cleanup();
      }
    }));
  };

  frame.addEventListener("load", run, { once: true });
  printDocument.open();
  printDocument.write(reportHtml(reportComponent));
  printDocument.close();
  cleanupTimer = window.setTimeout(cleanup, 60000);
  window.setTimeout(run, 750);
}

export function exportPDF(reportComponent) {
  printReport(reportComponent);
}

function pdfEscape(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").slice(0, 120);
}

function pdfText(x, y, text, size = 9, bold = false) {
  return `BT /${bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)} Tm (${pdfEscape(text)}) Tj ET\n`;
}

function simpleReportPdf(report) {
  const landscape = report?.orientation === "landscape";
  const page = landscape ? { w: 842, h: 595 } : { w: 595, h: 842 };
  const margin = 36;
  const columns = Array.isArray(report?.columns) ? report.columns : [];
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  const totals = Array.isArray(report?.totals) ? report.totals : [];
  const usableW = page.w - margin * 2;
  const colW = columns.length ? usableW / columns.length : usableW;
  const rowH = 16;
  const headerH = 118;
  const footerH = 32;
  const perPage = Math.max(8, Math.floor((page.h - headerH - footerH) / rowH));
  const chunks = [];
  for (let i = 0; i < rows.length; i += perPage) chunks.push(rows.slice(i, i + perPage));
  if (!chunks.length) chunks.push([]);

  const streams = chunks.map((chunk, pageIndex) => {
    let y = page.h - margin;
    let s = "";
    const generatedLabel = "Generated: " + new Date(report?.generatedAt || Date.now()).toLocaleString();
    s += pdfText(margin, y, report?.companyName || "VISIONPOS", 16, true);
    if (report?.prominentBranch) {
      const branchX = Math.max(margin + 210, page.w - margin - 300);
      s += pdfText(branchX, y, report?.branchName || "All branches", 22, true);
      y -= 18;
      s += pdfText(branchX, y, report?.title || "Report", 9, true);
      s += pdfText(margin, y, generatedLabel, 8);
      y -= 16;
      s += pdfText(margin, y, "Range: " + (report?.dateRange || "All time") + "    By: " + (report?.generatedBy || "VISIONPOS"), 8);
    } else {
      y -= 18;
      s += pdfText(margin, y, report?.title || "Report", 12, true);
      s += pdfText(page.w - margin - 190, page.h - margin, generatedLabel, 8);
      y -= 16;
      s += pdfText(margin, y, "Branch: " + (report?.branchName || "All branches") + "    Range: " + (report?.dateRange || "All time") + "    By: " + (report?.generatedBy || "VISIONPOS"), 8);
    }
    y -= 22;
    columns.forEach((c, i) => { s += pdfText(margin + i * colW, y, c.label, 8, true); });
    y -= 10;
    s += `${margin} ${y} m ${page.w - margin} ${y} l S\n`;
    y -= 14;
    chunk.forEach((row) => {
      columns.forEach((c, i) => { s += pdfText(margin + i * colW, y, row[c.key], 7.5); });
      y -= rowH;
    });
    if (pageIndex === chunks.length - 1 && totals.length) {
      y -= 8;
      s += `${margin} ${y} m ${page.w - margin} ${y} l S\n`;
      y -= 14;
      totals.forEach((t) => { s += pdfText(margin, y, t.label + ": " + t.value, 8, true); y -= 13; });
    }
    s += pdfText(margin, 24, "Generated by VISIONPOS", 7);
    s += pdfText(page.w - margin - 80, 24, `Page ${pageIndex + 1} of ${chunks.length}`, 7);
    return s;
  });

  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalog = add("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = add("");
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const boldId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const pageIds = [];
  streams.forEach((stream) => {
    const contentId = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${page.w} ${page.h}] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldId} 0 R >> >> /Contents ${contentId} 0 R >>`));
  });
  objects[pagesId - 1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => id + " 0 R").join(" ")}] >>`;

  let out = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) out += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([out], { type: "application/pdf" });
}

export function downloadPDF(reportComponent) {
  const blob = simpleReportPdf(reportComponent);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safeName(reportComponent?.title) + ".pdf";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function printReportHtml(reportComponent) {
  return reportHtml(reportComponent);
}
