(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var MAX_INNER_PACKAGES = 32;
  var MAX_INNER_DEPTH = 2;
  var state = { root: null, active: null, selected: new Set() };
  var crcTable = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n += 1) {
      var c = n;
      for (var k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function localName(node) {
    if (!node) return '';
    return String(node.localName || node.nodeName || '').split(':').pop();
  }

  function allElements(node, name) {
    var result = [];
    var list = node && node.getElementsByTagName ? node.getElementsByTagName('*') : [];
    for (var i = 0; i < list.length; i += 1) {
      if (localName(list[i]).toLowerCase() === String(name).toLowerCase()) result.push(list[i]);
    }
    return result;
  }

  function firstElement(node, name) {
    if (!node) return null;
    if (localName(node).toLowerCase() === String(name).toLowerCase()) return node;
    var list = allElements(node, name);
    return list.length ? list[0] : null;
  }

  function attr(node, name) {
    if (!node) return '';
    var direct = node.getAttribute(name);
    if (direct !== null && direct !== '') return direct;
    var attributes = node.attributes || [];
    for (var i = 0; i < attributes.length; i += 1) {
      if (localName(attributes[i]).toLowerCase() === String(name).toLowerCase()) return attributes[i].value;
    }
    return '';
  }

  function textOf(node) {
    return node ? String(node.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function parseXml(xml, label) {
    var doc = new DOMParser().parseFromString(xml, 'application/xml');
    var errors = doc.getElementsByTagName('parsererror');
    if (errors.length) throw new Error(label + ' is not valid XML.');
    if (!doc.documentElement) throw new Error(label + ' has no root element.');
    return doc;
  }

  function parseManifest(xml, manifestName) {
    var doc = parseXml(xml, manifestName);
    var root = doc.documentElement;
    var identityNode = firstElement(root, 'Identity');
    var properties = firstElement(root, 'Properties');
    var identity = {
      name: attr(identityNode, 'Name'),
      publisher: attr(identityNode, 'Publisher'),
      version: attr(identityNode, 'Version'),
      processorArchitecture: attr(identityNode, 'ProcessorArchitecture'),
      resourceId: attr(identityNode, 'ResourceId'),
      language: attr(identityNode, 'Language')
    };
    var displayName = textOf(firstElement(properties, 'DisplayName'));
    var description = textOf(firstElement(properties, 'Description'));
    var publisherDisplayName = attr(properties, 'PublisherDisplayName') || textOf(firstElement(properties, 'PublisherDisplayName'));
    var logoNode = firstElement(properties, 'Logo');
    var logo = attr(logoNode, 'Uri') || attr(logoNode, 'href') || textOf(logoNode);
    var capabilities = [];
    var seenCapabilities = {};
    allElements(root, 'Capability').forEach(function (node) {
      var name = attr(node, 'Name') || textOf(node);
      if (name && !seenCapabilities[name]) {
        seenCapabilities[name] = true;
        capabilities.push(name);
      }
    });
    var applications = allElements(root, 'Application').map(function (node) {
      var visual = firstElement(node, 'VisualElements');
      return {
        id: attr(node, 'Id'),
        executable: attr(node, 'Executable'),
        entryPoint: attr(node, 'EntryPoint'),
        startPage: attr(node, 'StartPage'),
        runtimeBehavior: attr(node, 'RuntimeBehavior'),
        resourceId: attr(node, 'ResourceId'),
        displayName: attr(visual, 'DisplayName'),
        description: textOf(firstElement(visual, 'Description'))
      };
    });
    var dependencies = allElements(root, 'PackageDependency').map(function (node) {
      return {
        name: attr(node, 'Name'),
        publisher: attr(node, 'Publisher'),
        minVersion: attr(node, 'MinVersion')
      };
    });
    var targetFamilies = allElements(root, 'TargetDeviceFamily').map(function (node) {
      return {
        name: attr(node, 'Name'),
        minVersion: attr(node, 'MinVersion'),
        maxVersionTested: attr(node, 'MaxVersionTested')
      };
    });
    var kind = localName(root).toLowerCase() === 'bundle' ? 'bundle' : 'package';
    var bundlePackages = kind === 'bundle' ? allElements(root, 'Package').filter(function (node) { return !!attr(node, 'FileName'); }).map(function (node) {
      return {
        file: attr(node, 'FileName'),
        type: attr(node, 'Type'),
        version: attr(node, 'Version'),
        size: attr(node, 'Size'),
        blockMapSize: attr(node, 'BlockMapSize'),
        offset: attr(node, 'Offset'),
        isResourcePackage: attr(node, 'IsResourcePackage') === 'true',
        signatureKind: attr(node, 'SignatureKind')
      };
    }) : [];
    return {
      kind: kind,
      rootName: localName(root),
      identity: identity,
      displayName: displayName,
      description: description,
      publisherDisplayName: publisherDisplayName,
      logo: logo,
      capabilities: capabilities,
      applications: applications,
      dependencies: dependencies,
      targetFamilies: targetFamilies,
      bundlePackages: bundlePackages,
      rawXml: xml,
      manifestName: manifestName
    };
  }

  function unzip(bytes) {
    var impl = window.fflateUnzipSync;
    if (!impl) throw new Error('The ZIP reader did not load. Reload the page and try again.');
    try {
      return impl(bytes);
    } catch (error) {
      throw new Error('This file could not be read as a ZIP/OPC package: ' + (error && error.message ? error.message : String(error)));
    }
  }

  function entryList(files) {
    return Object.keys(files).filter(function (name) { return !/\/$/.test(name); }).map(function (name) {
      var bytes = files[name] instanceof Uint8Array ? files[name] : new Uint8Array(files[name]);
      return { name: name, bytes: bytes, size: bytes.length };
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  function findEntry(entries, name) {
    var target = String(name || '').replace(/\\/g, '/').toLowerCase();
    for (var i = 0; i < entries.length; i += 1) {
      if (entries[i].name.replace(/\\/g, '/').toLowerCase() === target) return entries[i];
    }
    return null;
  }

  function findManifestEntry(entries) {
    var candidates = entries.filter(function (entry) {
      var name = entry.name.replace(/\\/g, '/').toLowerCase();
      return name === 'appxmanifest.xml' || name === 'appxbundlemanifest.xml' || name.endsWith('/appxmanifest.xml') || name.endsWith('/appxbundlemanifest.xml');
    });
    candidates.sort(function (a, b) { return a.name.length - b.name.length; });
    return candidates[0] || null;
  }

  function hasEntrySuffix(entries, suffix) {
    var target = String(suffix).toLowerCase();
    return entries.some(function (entry) {
      var name = entry.name.replace(/\\/g, '/').toLowerCase();
      return name === target || name.endsWith('/' + target);
    });
  }

  function inspectPackage(fileName, bytes, depth) {
    var files = unzip(bytes);
    var entries = entryList(files);
    if (!entries.length) throw new Error('The package contains no files.');
    var manifestEntry = findManifestEntry(entries);
    if (!manifestEntry) throw new Error('No AppxManifest.xml or AppxBundleManifest.xml was found. This may be a normal ZIP rather than an APPX/MSIX package.');
    var manifest = parseManifest(new TextDecoder('utf-8').decode(manifestEntry.bytes), manifestEntry.name);
    var warnings = [];
    var isBundle = manifest.kind === 'bundle' || /\.(appxbundle|msixbundle)$/i.test(fileName);
    if (isBundle && !manifest.bundlePackages.length) warnings.push('The bundle manifest did not list any inner package files.');
    if (!hasEntrySuffix(entries, 'AppxSignature.p7x')) warnings.push('No AppxSignature.p7x blob was found; this page does not verify signatures.');
    if (!hasEntrySuffix(entries, 'AppxBlockMap.xml')) warnings.push('No AppxBlockMap.xml was found in this package.');
    entries.forEach(function (entry) {
      if (safePath(entry.name) !== entry.name.replace(/\\/g, '/')) warnings.push('A file path was normalized for safe export: ' + entry.name);
    });
    var innerPackages = [];
    if (isBundle) {
      var descriptors = manifest.bundlePackages.slice(0, MAX_INNER_PACKAGES);
      if (manifest.bundlePackages.length > MAX_INNER_PACKAGES) warnings.push('Only the first ' + MAX_INNER_PACKAGES + ' inner packages were inspected.');
      descriptors.forEach(function (descriptor) {
        var innerEntry = findEntry(entries, descriptor.file);
        if (!innerEntry) {
          warnings.push('Inner package file is missing from the bundle: ' + descriptor.file);
          innerPackages.push({ fileName: descriptor.file, descriptor: descriptor, error: 'File not found' });
          return;
        }
        if (depth >= MAX_INNER_DEPTH) {
          warnings.push('Nested package inspection stopped at depth ' + MAX_INNER_DEPTH + ': ' + descriptor.file);
          innerPackages.push({ fileName: descriptor.file, descriptor: descriptor, error: 'Nested inspection limit reached' });
          return;
        }
        try {
          innerPackages.push({ fileName: descriptor.file, descriptor: descriptor, report: inspectPackage(descriptor.file, innerEntry.bytes, depth + 1) });
        } catch (error) {
          warnings.push('Could not inspect inner package ' + descriptor.file + ': ' + (error && error.message ? error.message : String(error)));
          innerPackages.push({ fileName: descriptor.file, descriptor: descriptor, error: error && error.message ? error.message : String(error) });
        }
      });
    }
    return {
      fileName: fileName,
      sourceBytes: bytes.length,
      entries: entries,
      manifestEntry: manifestEntry,
      manifest: manifest,
      isBundle: isBundle,
      innerPackages: innerPackages,
      warnings: warnings,
      totalSize: entries.reduce(function (sum, entry) { return sum + entry.size; }, 0),
      signaturePresent: hasEntrySuffix(entries, 'AppxSignature.p7x'),
      blockMapPresent: hasEntrySuffix(entries, 'AppxBlockMap.xml')
    };
  }

  function safePath(name) {
    var parts = [];
    String(name || '').replace(/\\/g, '/').split('/').forEach(function (part) {
      if (!part || part === '.') return;
      if (part === '..') {
        parts.pop();
        return;
      }
      parts.push(part.replace(/[\u0000-\u001f<>:"|?*]/g, '_'));
    });
    return parts.join('/') || 'unnamed-file';
  }

  function formatBytes(bytes) {
    if (bytes == null) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function crc32(bytes) {
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i += 1) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function createZip(entries) {
    var encoder = new TextEncoder();
    var localParts = [];
    var centralParts = [];
    var offset = 0;
    entries.forEach(function (entry) {
      var name = encoder.encode(safePath(entry.name));
      var data = entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes);
      var crc = crc32(data);
      var local = new Uint8Array(30 + name.length + data.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      local.set(name, 30);
      local.set(data, 30 + name.length);
      localParts.push(local);
      var central = new Uint8Array(46 + name.length);
      var cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      central.set(name, 46);
      centralParts.push(central);
      offset += local.length;
    });
    var centralSize = centralParts.reduce(function (sum, part) { return sum + part.length; }, 0);
    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    return new Blob(localParts.concat(centralParts, [end]), { type: 'application/zip' });
  }

  function appendRow(body, label, value) {
    var row = document.createElement('tr');
    var key = document.createElement('td');
    var val = document.createElement('td');
    key.textContent = label;
    val.textContent = value || '—';
    row.appendChild(key);
    row.appendChild(val);
    body.appendChild(row);
  }

  function renderIdentity(report) {
    var manifest = report.manifest;
    var identity = manifest.identity;
    $('displayName').textContent = manifest.displayName || identity.name || 'Unnamed package';
    $('publisherName').textContent = manifest.publisherDisplayName || identity.publisher || 'Unknown publisher';
    $('identityRows').textContent = '';
    appendRow($('identityRows'), 'Package name', identity.name);
    appendRow($('identityRows'), 'Publisher', identity.publisher);
    appendRow($('identityRows'), 'Version', identity.version);
    appendRow($('identityRows'), 'Architecture', identity.processorArchitecture);
    appendRow($('identityRows'), 'Resource ID', identity.resourceId);
    appendRow($('identityRows'), 'Language', identity.language);
    appendRow($('identityRows'), 'Logo', manifest.logo);
    appendRow($('identityRows'), 'Description', manifest.description);
    appendRow($('identityRows'), 'Dependencies', manifest.dependencies.map(function (dependency) { return (dependency.name || 'unnamed') + (dependency.minVersion ? ' ≥ ' + dependency.minVersion : ''); }).join(', '));
    appendRow($('identityRows'), 'Target families', manifest.targetFamilies.map(function (family) { return (family.name || 'unnamed') + (family.minVersion ? ' ≥ ' + family.minVersion : ''); }).join(', '));
    appendRow($('identityRows'), 'Manifest', manifest.manifestName);
    $('manifestPreview').textContent = manifest.rawXml;
  }

  function renderCapabilities(report) {
    var list = $('capabilityList');
    list.textContent = '';
    var capabilities = report.manifest.capabilities;
    $('capabilitySummary').textContent = capabilities.length ? capabilities.length + ' declared capabilit' + (capabilities.length === 1 ? 'y' : 'ies') + ':' : 'No capabilities found in the manifest.';
    capabilities.forEach(function (capability) {
      var chip = document.createElement('span');
      chip.className = 'chip accent';
      chip.textContent = capability;
      list.appendChild(chip);
    });
  }

  function renderApplications(report) {
    var container = $('applicationList');
    container.textContent = '';
    var applications = report.manifest.applications;
    if (!applications.length) {
      var empty = document.createElement('p');
      empty.textContent = 'No application entry point was declared.';
      container.appendChild(empty);
      return;
    }
    applications.forEach(function (application) {
      var item = document.createElement('p');
      var details = [application.id, application.executable, application.entryPoint, application.startPage].filter(Boolean).join(' · ');
      item.textContent = details || 'Application entry point (no attributes)';
      container.appendChild(item);
    });
  }

  function renderBundle(report) {
    var card = $('bundleCard');
    if (!report.isBundle || report !== state.root) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    var inner = report.innerPackages;
    $('bundleCount').textContent = inner.length + (inner.length === 1 ? ' inner package' : ' inner packages');
    $('bundleSummary').textContent = inner.length ? 'Select an inner package to read its manifest, or export the outer bundle unchanged from the file table.' : 'This bundle contains no recognized inner APPX or MSIX packages.';
    $('bundleList').textContent = '';
    inner.forEach(function (item, index) {
      var box = document.createElement('div');
      box.className = 'bundle-item';
      var name = document.createElement('strong');
      name.textContent = item.fileName;
      var detail = document.createElement('p');
      detail.textContent = item.error ? item.error : ((item.report && item.report.manifest.displayName) || 'Inner package');
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.report ? 'Inspect inner package' : 'Unavailable';
      button.disabled = !item.report;
      button.addEventListener('click', function () {
        state.active = item.report;
        state.selected = new Set();
        render();
        $('exportStatus').textContent = 'Viewing ' + item.fileName + '.';
      });
      box.appendChild(name);
      box.appendChild(detail);
      box.appendChild(button);
      $('bundleList').appendChild(box);
    });
  }

  function renderFiles(report) {
    var body = $('filesBody');
    body.textContent = '';
    $('fileCount').textContent = report.entries.length;
    $('fileCountLabel').textContent = report.entries.length + (report.entries.length === 1 ? ' file · ' : ' files · ') + formatBytes(report.totalSize) + ' unpacked';
    report.entries.forEach(function (entry, index) {
      var row = document.createElement('tr');
      var select = document.createElement('td');
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'file-check';
      checkbox.checked = state.selected.has(entry.name);
      checkbox.setAttribute('aria-label', 'Select ' + entry.name);
      checkbox.addEventListener('change', function () {
        if (checkbox.checked) state.selected.add(entry.name);
        else state.selected.delete(entry.name);
        updateExportStatus();
      });
      select.appendChild(checkbox);
      var path = document.createElement('td');
      path.textContent = entry.name;
      path.title = entry.name;
      if (safePath(entry.name) !== entry.name.replace(/\\/g, '/')) {
        var renamed = document.createElement('span');
        renamed.textContent = ' → ' + safePath(entry.name);
        renamed.style.color = 'var(--warn)';
        path.appendChild(renamed);
      }
      var size = document.createElement('td');
      size.textContent = formatBytes(entry.size);
      row.appendChild(select);
      row.appendChild(path);
      row.appendChild(size);
      body.appendChild(row);
    });
    if (!report.entries.length) {
      var row = document.createElement('tr');
      var cell = document.createElement('td');
      cell.colSpan = 3;
      cell.textContent = 'No files found.';
      row.appendChild(cell);
      body.appendChild(row);
    }
  }

  function renderWarnings(report) {
    var card = $('warningsCard');
    if (!report.warnings.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    $('warningsList').textContent = '';
    report.warnings.forEach(function (warning) {
      var item = document.createElement('li');
      item.textContent = warning;
      $('warningsList').appendChild(item);
    });
  }

  function render() {
    var report = state.active;
    $('resultsStack').hidden = false;
    $('packageKind').textContent = report.isBundle ? 'bundle' : 'package';
    $('unpackedSize').textContent = formatBytes(report.totalSize);
    $('backToBundleBtn').hidden = !state.root || report === state.root;
    renderIdentity(report);
    renderCapabilities(report);
    renderApplications(report);
    $('signatureState').textContent = report.signaturePresent ? 'present' : 'not found';
    $('blockMapState').textContent = report.blockMapPresent ? 'present' : 'not found';
    renderBundle(report);
    renderFiles(report);
    renderWarnings(report);
  }

  function updateExportStatus() {
    var count = state.selected.size;
    $('exportStatus').textContent = count ? count + ' file' + (count === 1 ? '' : 's') + ' selected. The export uses safe relative paths.' : 'No files selected. Use Select all files or choose individual rows.';
  }

  function reportSummary(report) {
    return {
      fileName: report.fileName,
      sourceBytes: report.sourceBytes,
      totalUncompressedBytes: report.totalSize,
      isBundle: report.isBundle,
      signatureBlobPresent: report.signaturePresent,
      blockMapPresent: report.blockMapPresent,
      manifest: {
        name: report.manifest.manifestName,
        root: report.manifest.rootName,
        kind: report.manifest.kind,
        identity: report.manifest.identity,
        displayName: report.manifest.displayName,
        description: report.manifest.description,
        publisherDisplayName: report.manifest.publisherDisplayName,
        logo: report.manifest.logo,
        capabilities: report.manifest.capabilities,
        xml: report.manifest.rawXml,
        applications: report.manifest.applications,
        dependencies: report.manifest.dependencies,
        targetFamilies: report.manifest.targetFamilies
      },
      files: report.entries.map(function (entry) { return { path: entry.name, size: entry.size, exportPath: safePath(entry.name) }; }),
      warnings: report.warnings,
      innerPackages: report.innerPackages.map(function (item) { return { file: item.fileName, descriptor: item.descriptor, identity: item.report ? item.report.manifest.identity : null, displayName: item.report ? item.report.manifest.displayName : null, error: item.error || null, inspected: !!item.report }; })
    };
  }

  function csvEscape(value) {
    var text = value == null ? '' : String(value);
    return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function download(filename, content, mime) {
    var blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function baseName() {
    var name = String(state.root && state.root.fileName || 'appx-package').replace(/\.(appxbundle|msixbundle|appx|msix|zip)$/i, '');
    return name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'appx-package';
  }

  function exportSelected(all) {
    if (!state.active) return;
    var entries = state.active.entries.filter(function (entry) { return all || state.selected.has(entry.name); });
    if (!entries.length) {
      $('exportStatus').textContent = 'Select at least one file before exporting.';
      return;
    }
    try {
      download(baseName() + '-contents.zip', createZip(entries), 'application/zip');
      $('exportStatus').textContent = 'Exported ' + entries.length + ' file' + (entries.length === 1 ? '' : 's') + ' as a ZIP. No package code was run.';
    } catch (error) {
      $('exportStatus').textContent = 'Could not build the ZIP: ' + (error && error.message ? error.message : String(error));
    }
  }

  function exportJson() {
    if (!state.active) return;
    download(baseName() + '-report.json', JSON.stringify(reportSummary(state.active), null, 2), 'application/json;charset=utf-8');
    $('exportStatus').textContent = 'Exported the manifest and file report as JSON.';
  }

  function exportCsv() {
    if (!state.active) return;
    var rows = [['path', 'size', 'exportPath']];
    state.active.entries.forEach(function (entry) { rows.push([entry.name, entry.size, safePath(entry.name)]); });
    download(baseName() + '-files.csv', rows.map(function (row) { return row.map(csvEscape).join(','); }).join('\r\n') + '\r\n', 'text/csv;charset=utf-8');
    $('exportStatus').textContent = 'Exported the file list as CSV.';
  }

  function setStatus(message, error) {
    $('status').textContent = message;
    $('status').classList.toggle('error', !!error);
  }

  async function handleFile(file) {
    if (!file) return;
    setStatus('Reading ' + file.name + ' locally…');
    $('fileName').textContent = file.name + ' · ' + formatBytes(file.size);
    try {
      var buffer = await file.arrayBuffer();
      var report = inspectPackage(file.name, new Uint8Array(buffer), 0);
      state.root = report;
      state.active = report;
      state.selected = new Set();
      render();
      setStatus('Read ' + report.entries.length + ' file' + (report.entries.length === 1 ? '' : 's') + ' and parsed ' + report.manifest.manifestName + '.');
      updateExportStatus();
    } catch (error) {
      state.root = null;
      state.active = null;
      $('resultsStack').hidden = true;
      setStatus(error && error.message ? error.message : String(error), true);
    }
  }

  function clearPackage() {
    state.root = null;
    state.active = null;
    state.selected = new Set();
    $('fileInput').value = '';
    $('fileName').textContent = 'No package loaded.';
    $('resultsStack').hidden = true;
    $('backToBundleBtn').hidden = true;
    $('exportStatus').textContent = 'The export preserves package paths and never runs an installer.';
    setStatus('The package stays in this browser tab. Nothing is uploaded or executed.');
  }

  function bindDrop() {
    var zone = $('dropzone');
    var input = $('fileInput');
    var setDrag = function (on) { zone.classList.toggle('drag', on); };
    ['dragenter', 'dragover'].forEach(function (eventName) { zone.addEventListener(eventName, function (event) { event.preventDefault(); setDrag(true); }); });
    ['dragleave', 'drop'].forEach(function (eventName) { zone.addEventListener(eventName, function (event) { event.preventDefault(); setDrag(false); }); });
    zone.addEventListener('click', function () { input.click(); });
    zone.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); } });
    zone.addEventListener('drop', function (event) { if (event.dataTransfer.files && event.dataTransfer.files[0]) handleFile(event.dataTransfer.files[0]); });
    input.addEventListener('change', function () { if (input.files && input.files[0]) handleFile(input.files[0]); input.value = ''; });
  }

  window.AppxUnpacker = { inspect: inspectPackage, safePath: safePath, zip: createZip };

  bindDrop();
  $('clearBtn').addEventListener('click', clearPackage);
  $('backToBundleBtn').addEventListener('click', function () {
    if (!state.root) return;
    state.active = state.root;
    state.selected = new Set();
    render();
    updateExportStatus();
  });
  $('extractSelectedBtn').addEventListener('click', function () { exportSelected(false); });
  $('extractAllBtn').addEventListener('click', function () { exportSelected(true); });
  $('selectAllBtn').addEventListener('click', function () {
    state.selected = new Set(state.active ? state.active.entries.map(function (entry) { return entry.name; }) : []);
    renderFiles(state.active);
    updateExportStatus();
  });
  $('exportJsonBtn').addEventListener('click', exportJson);
  $('exportCsvBtn').addEventListener('click', exportCsv);
})();
