// ═══════════════════════════════════════════════════════════════════════════
// GreenTrak — SINGLE authoritative Apps Script
// Data proxy (Sheet → CSV) + News + Account-aware CSV Consolidator + History
//
// This file replaces the old multi-file pile (Combined 5/4, Consolidator v2 4/1,
// data-proxy 3/1, and the unrelated 3/22 junk). Keep ONLY this file in the
// Apps Script project — duplicate function names across files collide.
//
// DEPLOY: paste into the editor as the only file, then
//   Deploy → Manage deployments → edit existing Web app → New version → Deploy
//   (keeps the same /exec URL the dashboard already uses).
//
// CONFIG: SHEET_ID and DRIVE_FOLDER_ID are placeholders here so this public repo
// holds no IDs. Fill in the real values in the deployed editor copy.
// ═══════════════════════════════════════════════════════════════════════════


// ─── CONFIG ──────────────────────────────────────────────────────────────
var CONFIG = {
  // Real values live in the deployed editor copy (kept out of the public repo).
  SHEET_ID: "YOUR_SHEET_ID_HERE",

  SHEET_TAB: "Holdings",
  HISTORY_TAB: "History",

  // CSV import folder — set the ID in the deployed copy; name is a fallback.
  DRIVE_FOLDER_ID: "YOUR_DRIVE_FOLDER_ID_HERE",
  DRIVE_FOLDER_NAME: "GreenTrak Imports",

  // Column layout: A = symbol (1), C = qty (3); data starts row 2
  SYMBOL_COL: 1,
  QTY_COL: 3,
  START_ROW: 2,

  // Account-specific handling (from Consolidator v2)
  DOUBLE_ACCOUNT: "6925",        // quantities in this account count ×2
  OFFSHORE_ACCOUNTS: ["6925"]    // offshore CSVs put qty in col 10 instead of 8
};

// Money market / cash fund tickers to skip
var SKIP_SYMBOLS = /^(FDRXX|FZFXX|SPAXX|VMFXX|SWVXX|SPRXX|FCASH|CORE|FMPXX|FTEXX)$/i;

// Specific tickers to exclude (delisted / bankrupt placeholders)
var EXCLUDE_SYMBOLS = { "LAZRQ": true, "SICPQ": true };

// Month abbreviations for date parsing
var MONTHS = {
  "Jan": 0, "Feb": 1, "Mar": 2, "Apr": 3, "May": 4, "Jun": 5,
  "Jul": 6, "Aug": 7, "Sep": 8, "Oct": 9, "Nov": 10, "Dec": 11
};


// ═══════════════════════════════════════════════════════════════════════════
// WEB APP ENTRY POINT — routes to data, news, parse, or history
// ═══════════════════════════════════════════════════════════════════════════

function doGet(e) {
  var params = (e && e.parameter) ? e.parameter : {};
  var action = params.action || "";
  var mode = params.mode || "";
  var callback = params.callback || "";

  // Route: CSV parse
  if (action === "parse") {
    var result = consolidate();
    return respond(result, callback);
  }

  // Route: Parse history
  if (action === "history") {
    return respond(getHistory(), callback);
  }

  // Route: News
  if (mode === "news") {
    return handleNews(e);
  }

  // Default: serve sheet data as CSV
  return handleData(e);
}


// ═══════════════════════════════════════════════════════════════════════════
// RESPONSE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function respond(payload, callback) {
  var jsonStr = JSON.stringify(payload);
  if (callback) {
    return ContentService.createTextOutput(callback + "(" + jsonStr + ")")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(jsonStr)
    .setMimeType(ContentService.MimeType.JSON);
}

function asJsonOrJsonp_(payload, e) {
  var cb = (e && e.parameter && e.parameter.callback) ? e.parameter.callback : null;
  if (cb) {
    return ContentService.createTextOutput(cb + "(" + JSON.stringify(payload) + ")")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}


// ═══════════════════════════════════════════════════════════════════════════
// DATA ENDPOINT — serves sheet data as CSV to the dashboard
// ═══════════════════════════════════════════════════════════════════════════

function handleData(e) {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.SHEET_TAB);

  if (!sheet) {
    return ContentService
      .createTextOutput('ERROR: Sheet tab "' + CONFIG.SHEET_TAB + '" not found.')
      .setMimeType(ContentService.MimeType.TEXT);
  }

  var data = sheet.getDataRange().getValues();

  var csv = data.map(function(row) {
    return row.map(function(cell) {
      return '"' + String(cell).replace(/"/g, '""') + '"';
    }).join(',');
  }).join('\n');

  // Support JSONP for GitHub Pages
  var cb = (e && e.parameter && e.parameter.callback) ? e.parameter.callback : null;
  if (cb) {
    return ContentService.createTextOutput(cb + "(" + JSON.stringify(csv) + ")")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(csv)
    .setMimeType(ContentService.MimeType.TEXT);
}


// ═══════════════════════════════════════════════════════════════════════════
// NEWS ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════

function handleNews(e) {
  var type = (e && e.parameter && e.parameter.type)
    ? String(e.parameter.type) : "market";
  var symbols = (e && e.parameter && e.parameter.symbols)
    ? String(e.parameter.symbols) : "";

  var query;

  if (type === "portfolio") {
    var list = symbols.split(",")
      .map(function(s){ return s.trim(); })
      .filter(function(s){ return s.length > 0; });
    if (list.length === 0) list = ["SPY", "QQQ"];
    query = "(" + list.join(" OR ") + ") (earnings OR guidance OR upgrade OR downgrade OR acquisition OR investigation OR lawsuit)";
  } else {
    query = "(stock market OR S&P 500 OR Nasdaq OR inflation OR Fed OR yields OR earnings)";
  }

  var rssUrl = "https://news.google.com/rss/search?q=" +
    encodeURIComponent(query) + "&hl=en-US&gl=US&ceid=US:en";

  var xmlText = UrlFetchApp.fetch(rssUrl).getContentText();
  var items = parseGoogleNewsRss_(xmlText, symbols);

  return asJsonOrJsonp_({ items: items.slice(0, 10) }, e);
}

function parseGoogleNewsRss_(xmlText, symbolsCsv) {
  var results = [];
  var syms = (symbolsCsv || "").split(",")
    .map(function(s){ return s.trim().toUpperCase(); })
    .filter(function(s){ return s.length > 0; });

  try {
    var document = XmlService.parse(xmlText);
    var channel = document.getRootElement().getChild("channel");
    var items = channel.getChildren("item");

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var title = item.getChildText("title") || "";
      var link = item.getChildText("link") || "";
      var pubDate = item.getChildText("pubDate") || "";

      var source = "";
      var dash = title.lastIndexOf(" - ");
      if (dash > 0) {
        source = title.substring(dash + 3).trim();
        title = title.substring(0, dash).trim();
      }

      var matchedSymbol = "";
      var upperTitle = title.toUpperCase();
      for (var k = 0; k < syms.length; k++) {
        if (upperTitle.indexOf(syms[k]) !== -1) {
          matchedSymbol = syms[k];
          break;
        }
      }

      results.push({
        title: title,
        url: link,
        source: source,
        ago: pubDate,
        symbol: matchedSymbol
      });
    }
  } catch (err) {
    return [];
  }

  return results;
}


// ═══════════════════════════════════════════════════════════════════════════
// CSV CONSOLIDATOR (account-aware: offshore column + ×2 doubling)
// ═══════════════════════════════════════════════════════════════════════════

function consolidate() {
  var folder = findFolder();
  if (!folder) return { status: "error", message: "Import folder not found. Create a Google Drive folder called '" + CONFIG.DRIVE_FOLDER_NAME + "' (or set DRIVE_FOLDER_ID) and upload your brokerage CSVs." };

  // Capture previous state for history
  var oldPositions = getExistingPositions();
  var oldCount = Object.keys(oldPositions).length;

  // Pass 1: scan all CSVs and find the most recent date
  var allFiles = [];
  var latestDate = null;

  var iter = folder.getFilesByType(MimeType.CSV);
  while (iter.hasNext()) {
    var file = iter.next();
    var filename = file.getName();
    var fileDate = parseDateFromFilename(filename);
    allFiles.push({ file: file, filename: filename, date: fileDate });
    if (fileDate && (!latestDate || fileDate > latestDate)) {
      latestDate = fileDate;
    }
  }

  if (allFiles.length === 0) {
    return { status: "error", message: "No CSV files found in import folder." };
  }

  if (!latestDate) {
    Logger.log("No valid dates found in filenames. Processing all files.");
  }

  // Pass 2: process only files matching the latest date
  var allPositions = {};
  var fileCount = 0;
  var skippedCount = 0;

  for (var f = 0; f < allFiles.length; f++) {
    var entry = allFiles[f];

    // Skip files that don't match the latest date
    if (latestDate && entry.date) {
      if (entry.date.getTime() !== latestDate.getTime()) {
        skippedCount++;
        Logger.log("SKIPPED (old): " + entry.filename);
        continue;
      }
    }
    // Skip files with no parseable date (not a positions file)
    if (latestDate && !entry.date) {
      skippedCount++;
      Logger.log("SKIPPED (no date): " + entry.filename);
      continue;
    }

    fileCount++;
    Logger.log("PROCESSING: " + entry.filename);

    var content = entry.file.getBlob().getDataAsString("latin1");
    var rows = Utilities.parseCsv(content);

    // Account number from the data itself (column 0, first data row)
    var acctNum = "";
    if (rows.length > 1 && rows[1] && rows[1][0]) {
      acctNum = rows[1][0].trim();
    }

    var isOffshore = CONFIG.OFFSHORE_ACCOUNTS.indexOf(acctNum) !== -1;
    var multiplier = (acctNum === CONFIG.DOUBLE_ACCOUNT) ? 2 : 1;

    var symColIdx = 4;
    var qtyColIdx = isOffshore ? 10 : 8;

    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row || row.length <= Math.max(symColIdx, qtyColIdx)) continue;

      var rawSym = (row[symColIdx] || "").trim().toUpperCase();
      var rawQty = (row[qtyColIdx] || "").trim();

      if (!rawSym || !rawQty) continue;

      // Valid tickers: 1-6 uppercase letters, optionally with dot (BRK.B)
      if (!/^[A-Z]{1,6}[.]?[A-Z]?$/.test(rawSym)) continue;
      if (SKIP_SYMBOLS.test(rawSym)) continue;
      if (EXCLUDE_SYMBOLS[rawSym]) continue;

      var qty = parseFloat(rawQty.replace(/,/g, ""));
      if (isNaN(qty) || qty === 0) continue;

      allPositions[rawSym] = (allPositions[rawSym] || 0) + (qty * multiplier);
    }
  }

  if (fileCount === 0) {
    return { status: "error", message: "No files matched the latest date." };
  }

  var symbols = Object.keys(allPositions)
    .filter(function(s) { return Math.abs(allPositions[s]) > 0.001; })
    .sort();

  writeToSheet(symbols, allPositions);

  // Compute diff for history
  var newCount = symbols.length;
  var added = 0, removed = 0, changed = 0;
  var newSet = {};
  symbols.forEach(function(s) { newSet[s] = allPositions[s]; });

  symbols.forEach(function(s) {
    if (!(s in oldPositions)) added++;
    else if (Math.abs(oldPositions[s] - allPositions[s]) > 0.01) changed++;
  });

  Object.keys(oldPositions).forEach(function(s) {
    if (!(s in newSet)) removed++;
  });

  var dateStr = latestDate
    ? (latestDate.getMonth() + 1) + "/" + latestDate.getDate() + "/" + latestDate.getFullYear()
    : "all";

  logHistory(latestDate, oldCount, newCount, added, removed, changed, fileCount);

  Logger.log("DONE — " + newCount + " positions from " + fileCount +
    " files dated " + dateStr + " (" + skippedCount + " skipped). " +
    "+" + added + " / -" + removed + " / ~" + changed);

  return {
    status: "success",
    csvDate: dateStr,
    filesProcessed: fileCount,
    filesSkipped: skippedCount,
    previousPositions: oldCount,
    newPositions: newCount,
    added: added,
    removed: removed,
    changed: changed
  };
}


// ═══════════════════════════════════════════════════════════════════════════
// DATE PARSER — extracts date from filename like "28-Feb-2026.csv"
// ═══════════════════════════════════════════════════════════════════════════

function parseDateFromFilename(filename) {
  if (!filename) return null;
  var m = filename.match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})\.csv$/);
  if (!m) return null;
  var day = parseInt(m[1], 10);
  var mon = MONTHS[m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase()];
  var year = parseInt(m[3], 10);
  if (mon === undefined) return null;
  return new Date(year, mon, day);
}


// ═══════════════════════════════════════════════════════════════════════════
// GET EXISTING POSITIONS (for history diff)
// ═══════════════════════════════════════════════════════════════════════════

function getExistingPositions() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.SHEET_TAB);
  if (!sheet) return {};

  var lastRow = sheet.getLastRow();
  if (lastRow < CONFIG.START_ROW) return {};

  var numRows = lastRow - CONFIG.START_ROW + 1;
  var symbols = sheet.getRange(CONFIG.START_ROW, CONFIG.SYMBOL_COL, numRows, 1).getValues();
  var qtys = sheet.getRange(CONFIG.START_ROW, CONFIG.QTY_COL, numRows, 1).getValues();

  var positions = {};
  for (var i = 0; i < symbols.length; i++) {
    var sym = String(symbols[i][0] || "").trim();
    var qty = parseFloat(String(qtys[i][0] || "0").replace(/,/g, ""));
    if (sym && !isNaN(qty)) positions[sym] = qty;
  }
  return positions;
}


// ═══════════════════════════════════════════════════════════════════════════
// WRITE TO SHEET
// ═══════════════════════════════════════════════════════════════════════════

function writeToSheet(symbols, positions) {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.SHEET_TAB);

  if (!sheet) {
    Logger.log("ERROR: Sheet tab '" + CONFIG.SHEET_TAB + "' not found.");
    return;
  }

  var lastRow = sheet.getLastRow();

  // Clear old data: columns A through J
  if (lastRow >= CONFIG.START_ROW) {
    sheet.getRange(CONFIG.START_ROW, 1, lastRow - CONFIG.START_ROW + 1, 10).clearContent();
  }

  if (symbols.length === 0) return;

  var n = symbols.length;

  // Column A: symbols
  var symData = symbols.map(function(s) { return [s]; });

  // Column C: quantities (round whole numbers, keep decimals for fractional shares)
  var qtyData = symbols.map(function(s) {
    var q = positions[s];
    return [Math.abs(q - Math.round(q)) < 0.01 ? Math.round(q) : parseFloat(q.toFixed(3))];
  });

  sheet.getRange(CONFIG.START_ROW, CONFIG.SYMBOL_COL, n, 1).setValues(symData);
  sheet.getRange(CONFIG.START_ROW, CONFIG.QTY_COL, n, 1).setValues(qtyData);

  // Columns B, D, E, F, G, H, I, J: formulas
  var formulaData = [];
  for (var i = 0; i < n; i++) {
    var r = CONFIG.START_ROW + i;
    formulaData.push([
      '=IF(A' + r + '="","",IFERROR(GOOGLEFINANCE(A' + r + ',"name"),""))',
      '=IFNA(INDEX(GOOGLEFINANCE(A' + r + ',"price",TODAY()-1),2,2),INDEX(GOOGLEFINANCE(A' + r + ',"price",TODAY()-4),2,2))',
      '=GOOGLEFINANCE(A' + r + ')',
      '=E' + r + '*C' + r,
      '=F' + r + '/$M$5',
      '=IFERROR((E' + r + '-D' + r + ')*C' + r + ',0)',
      '=(E' + r + '-D' + r + ')/D' + r,
      '=E' + r + '-D' + r
    ]);
  }

  var colB = formulaData.map(function(row) { return [row[0]]; });
  sheet.getRange(CONFIG.START_ROW, 2, n, 1).setFormulas(colB);

  var colsDtoJ = formulaData.map(function(row) { return row.slice(1); });
  sheet.getRange(CONFIG.START_ROW, 4, n, 7).setFormulas(colsDtoJ);

  // Number formats
  sheet.getRange(CONFIG.START_ROW, 4, n, 1).setNumberFormat("#,##0.00");   // D: prev close
  sheet.getRange(CONFIG.START_ROW, 6, n, 1).setNumberFormat("#,##0");       // F: market value
  sheet.getRange(CONFIG.START_ROW, 7, n, 1).setNumberFormat("0%");          // G: % of total
  sheet.getRange(CONFIG.START_ROW, 8, n, 1).setNumberFormat("#,##0");       // H: day gain $
  sheet.getRange(CONFIG.START_ROW, 9, n, 1).setNumberFormat("0%");          // I: day gain %
  sheet.getRange(CONFIG.START_ROW, 10, n, 1).setNumberFormat("$#,##0.0");   // J: price change
}


// ═══════════════════════════════════════════════════════════════════════════
// HISTORY LOGGER
// ═══════════════════════════════════════════════════════════════════════════

function logHistory(csvDate, oldCount, newCount, added, removed, changed, fileCount) {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.HISTORY_TAB);

  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.HISTORY_TAB);
    sheet.getRange(1, 1, 1, 9).setValues([[
      "Run Date", "Run Time", "CSV Date", "Files Processed",
      "Previous Positions", "New Positions", "Added", "Removed", "Changed"
    ]]);
    sheet.getRange(1, 1, 1, 9)
      .setFontWeight("bold")
      .setBackground("#1e293b")
      .setFontColor("#ffffff");
    sheet.setFrozenRows(1);
  }

  var now = new Date();
  var runDate = (now.getMonth() + 1) + "/" + now.getDate() + "/" + now.getFullYear();
  var runTime = Utilities.formatDate(now, Session.getScriptTimeZone(), "h:mm:ss a");
  var csvDateStr = csvDate
    ? (csvDate.getMonth() + 1) + "/" + csvDate.getDate() + "/" + csvDate.getFullYear()
    : "";

  var nextRow = sheet.getLastRow() + 1;
  sheet.getRange(nextRow, 1, 1, 9).setValues([[
    runDate, runTime, csvDateStr, fileCount,
    oldCount, newCount, "+" + added, "-" + removed, "~" + changed
  ]]);
}


// ═══════════════════════════════════════════════════════════════════════════
// GET HISTORY
// ═══════════════════════════════════════════════════════════════════════════

function getHistory() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.HISTORY_TAB);

  if (!sheet || sheet.getLastRow() < 2) {
    return { status: "success", history: [] };
  }

  var lastRow = sheet.getLastRow();
  var startRow = Math.max(2, lastRow - 19);
  var numRows = lastRow - startRow + 1;
  var data = sheet.getRange(startRow, 1, numRows, 9).getValues();

  var history = [];
  for (var i = data.length - 1; i >= 0; i--) {
    history.push({
      runDate: data[i][0], runTime: data[i][1], csvDate: data[i][2],
      filesProcessed: data[i][3], previousPositions: data[i][4],
      newPositions: data[i][5], added: data[i][6],
      removed: data[i][7], changed: data[i][8]
    });
  }

  return { status: "success", history: history };
}


// ═══════════════════════════════════════════════════════════════════════════
// FOLDER FINDER — supports both folder ID and folder name
// ═══════════════════════════════════════════════════════════════════════════

function findFolder() {
  // Try by ID first
  if (CONFIG.DRIVE_FOLDER_ID && CONFIG.DRIVE_FOLDER_ID !== "YOUR_DRIVE_FOLDER_ID_HERE") {
    try {
      return DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
    } catch (e) {
      Logger.log("Folder ID lookup failed: " + e.message);
    }
  }

  // Fall back to name search
  if (CONFIG.DRIVE_FOLDER_NAME) {
    var folders = DriveApp.getFoldersByName(CONFIG.DRIVE_FOLDER_NAME);
    if (folders.hasNext()) return folders.next();
  }

  return null;
}


// ═══════════════════════════════════════════════════════════════════════════
// MONTHLY TRIGGER
// ═══════════════════════════════════════════════════════════════════════════

function createMonthlyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(t) {
    if (t.getHandlerFunction() === "consolidate") {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger("consolidate")
    .timeBased()
    .onMonthDay(1)
    .atHour(9)
    .create();
  Logger.log("Monthly trigger set.");
}


// ═══════════════════════════════════════════════════════════════════════════
// DIAGNOSTIC — run from Apps Script editor to test
// ═══════════════════════════════════════════════════════════════════════════

function diagnose() {
  var folder = findFolder();
  if (!folder) { Logger.log("ERROR: Folder not found"); return; }
  Logger.log("Folder name: " + folder.getName());

  var iter = folder.getFilesByType(MimeType.CSV);
  var count = 0;
  while (iter.hasNext()) {
    var file = iter.next();
    Logger.log("  File: " + file.getName() + " → date: " + parseDateFromFilename(file.getName()));
    count++;
  }
  Logger.log("Total CSV files found: " + count);
}
