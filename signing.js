// Certificate signing for PDFs (PAdES-style detached PKCS#7 signature, SHA-256).
// Plain script: defines the global PdfSigner. Uses node-forge (vendor/forge) for the cryptography.
//
// How it works:
// 1. addPlaceholder() adds a signature field whose /Contents is a fixed-size run of zeros and whose /ByteRange
//    has fixed-width placeholder numbers. The PDF is then saved without object streams, so the text is readable.
// 2. sign() writes the real /ByteRange, hashes everything except the /Contents value, signs the hash with the
//    certificate, and writes the signature into the reserved space. The file length does not change.
// The signed PDF is a new file. Saving the open document again would remove the signature.
(function (root) {
  const HEX = 2 * 16384; // room for the signature: 16 KB, in hex
  const PLACEHOLDER_RANGE = '1111111111 2222222222 3333333333';

  function toBin(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return s;
  }

  function fromBin(s) {
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255;
    return u;
  }

  function pad10(n) {
    return String(n).padStart(10, '0');
  }

  // Adds the empty signature field to a pdf-lib document. Call before save(), with useObjectStreams: false.
  function addPlaceholder(PDFLib, out, page) {
    const { PDFDict, PDFArray, PDFName, PDFNumber, PDFHexString } = PDFLib;
    const ctx = out.context;
    const sig = PDFDict.withContext(ctx);
    sig.set(PDFName.of('Type'), PDFName.of('Sig'));
    sig.set(PDFName.of('Filter'), PDFName.of('Adobe.PPKLite'));
    sig.set(PDFName.of('SubFilter'), PDFName.of('adbe.pkcs7.detached'));
    const br = PDFArray.withContext(ctx);
    for (const n of [0, 1111111111, 2222222222, 3333333333]) br.push(PDFNumber.of(n));
    sig.set(PDFName.of('ByteRange'), br);
    sig.set(PDFName.of('Contents'), PDFHexString.of('0'.repeat(HEX)));
    sig.set(PDFName.of('Reason'), PDFHexString.fromText('Signed in Tabbed PDF'));
    const sigRef = ctx.register(sig);

    const field = PDFDict.withContext(ctx);
    field.set(PDFName.of('Type'), PDFName.of('Annot'));
    field.set(PDFName.of('Subtype'), PDFName.of('Widget'));
    field.set(PDFName.of('FT'), PDFName.of('Sig'));
    field.set(PDFName.of('T'), PDFHexString.fromText('Signature1'));
    field.set(PDFName.of('V'), sigRef);
    const rect = PDFArray.withContext(ctx);
    for (const n of [0, 0, 0, 0]) rect.push(PDFNumber.of(n)); // invisible signature
    field.set(PDFName.of('Rect'), rect);
    field.set(PDFName.of('F'), PDFNumber.of(132)); // print + hidden
    field.set(PDFName.of('P'), page.ref);
    const fieldRef = ctx.register(field);
    page.node.addAnnot(fieldRef);

    const form = out.getForm();
    form.acroForm.addField(fieldRef);
    form.acroForm.dict.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  }

  // Reads the certificate and private key from a .p12 / .pfx file (binary string).
  function readP12(forge, p12Bin, password) {
    let p12;
    try {
      const asn1 = forge.asn1.fromDer(p12Bin);
      p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password);
    } catch (err) {
      throw new Error('The file could not be opened. Check the password, and that it is a .p12 or .pfx file.');
    }
    const certs = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
    const keys = (p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [])
      .concat(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []);
    const cert = certs.find((c) => c.cert)?.cert;
    const key = keys.find((k) => k.key)?.key;
    if (!cert || !key) throw new Error('The file has no certificate with a private key.');
    return { cert, key };
  }

  function signerName(cert) {
    const cn = cert.subject.getField('CN');
    return cn ? cn.value : 'certificate';
  }

  // Signs a PDF that was built with addPlaceholder(). Returns { bytes, signer }.
  function sign(forge, pdfBytes, { p12, password }) {
    const { cert, key } = readP12(forge, p12, password);
    let bin = toBin(pdfBytes);
    const reserved = '0'.repeat(HEX);
    const at = bin.indexOf('<' + reserved + '>');
    if (at < 0) throw new Error('No signature field in this file.');
    const s = at;               // position of '<'
    const c = s + HEX + 2;      // position after '>'
    const d = bin.length - c;
    const ranges = pad10(s) + ' ' + pad10(c) + ' ' + pad10(d);
    if (bin.indexOf(PLACEHOLDER_RANGE) < 0) throw new Error('No signature byte range in this file.');
    bin = bin.replace(PLACEHOLDER_RANGE, ranges); // same length, so the offsets above still hold

    const signedData = bin.slice(0, s) + bin.slice(c);
    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(signedData);
    p7.addCertificate(cert);
    p7.addSigner({
      key,
      certificate: cert,
      digestAlgorithm: forge.pki.oids.sha256,
      authenticatedAttributes: [
        { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
        { type: forge.pki.oids.messageDigest },
        { type: forge.pki.oids.signingTime, value: new Date() },
      ],
    });
    p7.sign({ detached: true });
    const der = forge.util.bytesToHex(forge.asn1.toDer(p7.toAsn1()).getBytes());
    if (der.length > HEX) throw new Error('The signature is too large for the space reserved in the file.');
    const hex = der + '0'.repeat(HEX - der.length);
    bin = bin.slice(0, s + 1) + hex + bin.slice(s + 1 + HEX);
    return { bytes: fromBin(bin), signer: signerName(cert) };
  }

  // For checking a signed file outside the app: returns the signed byte ranges and the DER signature.
  // (node-forge does not verify PKCS#7 signatures, so the check is done with OpenSSL in the tests.)
  function extract(pdfBytes) {
    const bin = toBin(pdfBytes);
    const m = bin.match(/\/ByteRange\s*\[\s*0\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/);
    if (!m) return null;
    const b = Number(m[1]), c = Number(m[2]), d = Number(m[3]);
    const data = bin.slice(0, b) + bin.slice(c, c + d);
    const hex = bin.slice(b + 1, c - 1);
    return { data: fromBin(data), der: fromBin(hexToBin(hex)) };
  }

  function hexToBin(hex) {
    let s = '';
    for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    return s;
  }

  const api = { addPlaceholder, sign, extract, toBin, fromBin };
  root.PdfSigner = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
