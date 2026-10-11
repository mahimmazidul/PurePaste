import qrcode from "qrcode-generator";

/**
 * QR generation is loaded on demand: the entry bundle does not pay for it until
 * somebody asks for a code.
 */
export function renderQrSvg(value: string, size = 232): string {
	// 'M' tolerates a reasonable amount of camera blur while keeping the grid small.
	const qr = qrcode(0, "M");
	qr.addData(value);
	qr.make();

	const count = qr.getModuleCount();
	const quiet = 3;
	const total = count + quiet * 2;
	const paths: string[] = [];
	for (let row = 0; row < count; row += 1) {
		for (let column = 0; column < count; column += 1) {
			if (qr.isDark(row, column)) {
				paths.push(`M${column + quiet} ${row + quiet}h1v1h-1z`);
			}
		}
	}

	return `<svg class="qr" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" role="img" aria-label="QR code for this link" shape-rendering="crispEdges"><rect width="${total}" height="${total}" rx="1.5" fill="var(--qr-background, #ffffff)"/><path d="${paths.join("")}" fill="var(--qr-foreground, #101713)"/></svg>`;
}
