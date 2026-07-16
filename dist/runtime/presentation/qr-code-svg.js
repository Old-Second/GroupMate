/*!
 * QR encoder adapted from qrcode.vue v3.4.0 / Nayuki QR Code generator.
 * Copyright (c) 2017-2023 @scopewu and Project Nayuki.
 * Released under the MIT License.
 */
const MEDIUM_ECC_CODEWORDS_PER_BLOCK = Object.freeze([
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28,
    26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
    28, 28, 28, 28, 28
]);
const MEDIUM_ERROR_CORRECTION_BLOCKS = Object.freeze([
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
    17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47,
    49
]);
function appendBits(value, length, output) {
    if (length < 0 || length > 31 || value >>> length !== 0)
        throw new RangeError('Value out of range');
    for (let index = length - 1; index >= 0; index--)
        output.push((value >>> index) & 1);
}
function bit(value, index) {
    return ((value >>> index) & 1) !== 0;
}
function rawDataModules(version) {
    if (version < 1 || version > 40)
        throw new RangeError('Version out of range');
    let result = (16 * version + 128) * version + 64;
    if (version >= 2) {
        const align = Math.floor(version / 7) + 2;
        result -= (25 * align - 10) * align - 55;
        if (version >= 7)
            result -= 36;
    }
    return result;
}
function dataCodewords(version) {
    return Math.floor(rawDataModules(version) / 8) -
        MEDIUM_ECC_CODEWORDS_PER_BLOCK[version] * MEDIUM_ERROR_CORRECTION_BLOCKS[version];
}
function reedSolomonMultiply(left, right) {
    if ((left >>> 8) !== 0 || (right >>> 8) !== 0)
        throw new RangeError('Byte out of range');
    let result = 0;
    for (let index = 7; index >= 0; index--) {
        result = (result << 1) ^ ((result >>> 7) * 0x11d);
        result ^= ((right >>> index) & 1) * left;
    }
    return result;
}
function reedSolomonDivisor(degree) {
    const result = Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let index = 0; index < degree; index++) {
        for (let position = 0; position < result.length; position++) {
            result[position] = reedSolomonMultiply(result[position], root);
            if (position + 1 < result.length)
                result[position] ^= result[position + 1];
        }
        root = reedSolomonMultiply(root, 2);
    }
    return result;
}
function reedSolomonRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const value of data) {
        const factor = value ^ result.shift();
        result.push(0);
        divisor.forEach((coefficient, index) => {
            result[index] ^= reedSolomonMultiply(coefficient, factor);
        });
    }
    return result;
}
class MediumQrMatrix {
    version;
    size;
    modules;
    isFunction;
    constructor(version, data) {
        this.version = version;
        this.size = version * 4 + 17;
        this.modules = Array.from({ length: this.size }, () => Array(this.size).fill(false));
        this.isFunction = Array.from({ length: this.size }, () => Array(this.size).fill(false));
        this.drawFunctionPatterns();
        this.drawCodewords(this.addErrorCorrection(data));
        let selectedMask = 0;
        let minimumPenalty = Number.POSITIVE_INFINITY;
        for (let mask = 0; mask < 8; mask++) {
            this.applyMask(mask);
            this.drawFormatBits(mask);
            const penalty = this.penaltyScore();
            if (penalty < minimumPenalty) {
                selectedMask = mask;
                minimumPenalty = penalty;
            }
            this.applyMask(mask);
        }
        this.applyMask(selectedMask);
        this.drawFormatBits(selectedMask);
    }
    setFunction(x, y, dark) {
        this.modules[y][x] = dark;
        this.isFunction[y][x] = true;
    }
    drawFunctionPatterns() {
        for (let index = 0; index < this.size; index++) {
            this.setFunction(6, index, index % 2 === 0);
            this.setFunction(index, 6, index % 2 === 0);
        }
        this.drawFinder(3, 3);
        this.drawFinder(this.size - 4, 3);
        this.drawFinder(3, this.size - 4);
        const positions = this.alignmentPositions();
        for (let row = 0; row < positions.length; row++) {
            for (let column = 0; column < positions.length; column++) {
                if ((row === 0 && column === 0) ||
                    (row === 0 && column === positions.length - 1) ||
                    (row === positions.length - 1 && column === 0))
                    continue;
                this.drawAlignment(positions[column], positions[row]);
            }
        }
        this.drawFormatBits(0);
        this.drawVersion();
    }
    drawFinder(x, y) {
        for (let deltaY = -4; deltaY <= 4; deltaY++) {
            for (let deltaX = -4; deltaX <= 4; deltaX++) {
                const distance = Math.max(Math.abs(deltaX), Math.abs(deltaY));
                const targetX = x + deltaX;
                const targetY = y + deltaY;
                if (targetX >= 0 && targetX < this.size && targetY >= 0 && targetY < this.size) {
                    this.setFunction(targetX, targetY, distance !== 2 && distance !== 4);
                }
            }
        }
    }
    drawAlignment(x, y) {
        for (let deltaY = -2; deltaY <= 2; deltaY++) {
            for (let deltaX = -2; deltaX <= 2; deltaX++) {
                this.setFunction(x + deltaX, y + deltaY, Math.max(Math.abs(deltaX), Math.abs(deltaY)) !== 1);
            }
        }
    }
    drawFormatBits(mask) {
        const data = mask; // Error correction M has format bits 00.
        let remainder = data;
        for (let index = 0; index < 10; index++)
            remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
        const bits = ((data << 10) | remainder) ^ 0x5412;
        for (let index = 0; index <= 5; index++)
            this.setFunction(8, index, bit(bits, index));
        this.setFunction(8, 7, bit(bits, 6));
        this.setFunction(8, 8, bit(bits, 7));
        this.setFunction(7, 8, bit(bits, 8));
        for (let index = 9; index < 15; index++)
            this.setFunction(14 - index, 8, bit(bits, index));
        for (let index = 0; index < 8; index++)
            this.setFunction(this.size - 1 - index, 8, bit(bits, index));
        for (let index = 8; index < 15; index++)
            this.setFunction(8, this.size - 15 + index, bit(bits, index));
        this.setFunction(8, this.size - 8, true);
    }
    drawVersion() {
        if (this.version < 7)
            return;
        let remainder = this.version;
        for (let index = 0; index < 12; index++)
            remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
        const bits = (this.version << 12) | remainder;
        for (let index = 0; index < 18; index++) {
            const dark = bit(bits, index);
            const x = this.size - 11 + index % 3;
            const y = Math.floor(index / 3);
            this.setFunction(x, y, dark);
            this.setFunction(y, x, dark);
        }
    }
    alignmentPositions() {
        if (this.version === 1)
            return [];
        const count = Math.floor(this.version / 7) + 2;
        const step = this.version === 32
            ? 26
            : 2 * Math.ceil((this.version * 4 + 4) / (count * 2 - 2));
        const result = [6];
        for (let position = this.size - 7; result.length < count; position -= step)
            result.splice(1, 0, position);
        return result;
    }
    addErrorCorrection(data) {
        if (data.length !== dataCodewords(this.version))
            throw new RangeError('Invalid data length');
        const blockCount = MEDIUM_ERROR_CORRECTION_BLOCKS[this.version];
        const eccLength = MEDIUM_ECC_CODEWORDS_PER_BLOCK[this.version];
        const rawCodewords = Math.floor(rawDataModules(this.version) / 8);
        const shortBlockCount = blockCount - rawCodewords % blockCount;
        const shortBlockLength = Math.floor(rawCodewords / blockCount);
        const divisor = reedSolomonDivisor(eccLength);
        const blocks = [];
        let offset = 0;
        for (let block = 0; block < blockCount; block++) {
            const dataLength = shortBlockLength - eccLength + (block < shortBlockCount ? 0 : 1);
            const current = data.slice(offset, offset + dataLength);
            offset += dataLength;
            const remainder = reedSolomonRemainder(current, divisor);
            if (block < shortBlockCount)
                current.push(0);
            blocks.push(current.concat(remainder));
        }
        const result = [];
        for (let index = 0; index < blocks[0].length; index++) {
            blocks.forEach((block, blockIndex) => {
                if (index !== shortBlockLength - eccLength || blockIndex >= shortBlockCount)
                    result.push(block[index]);
            });
        }
        return result;
    }
    drawCodewords(data) {
        let bitIndex = 0;
        for (let right = this.size - 1; right >= 1; right -= 2) {
            if (right === 6)
                right = 5;
            for (let vertical = 0; vertical < this.size; vertical++) {
                for (let offset = 0; offset < 2; offset++) {
                    const x = right - offset;
                    const upward = ((right + 1) & 2) === 0;
                    const y = upward ? this.size - 1 - vertical : vertical;
                    if (!this.isFunction[y][x] && bitIndex < data.length * 8) {
                        this.modules[y][x] = bit(data[bitIndex >>> 3], 7 - (bitIndex & 7));
                        bitIndex++;
                    }
                }
            }
        }
    }
    applyMask(mask) {
        for (let y = 0; y < this.size; y++) {
            for (let x = 0; x < this.size; x++) {
                let invert = false;
                switch (mask) {
                    case 0:
                        invert = (x + y) % 2 === 0;
                        break;
                    case 1:
                        invert = y % 2 === 0;
                        break;
                    case 2:
                        invert = x % 3 === 0;
                        break;
                    case 3:
                        invert = (x + y) % 3 === 0;
                        break;
                    case 4:
                        invert = (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
                        break;
                    case 5:
                        invert = (x * y) % 2 + (x * y) % 3 === 0;
                        break;
                    case 6:
                        invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0;
                        break;
                    case 7:
                        invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0;
                        break;
                }
                if (!this.isFunction[y][x] && invert)
                    this.modules[y][x] = !this.modules[y][x];
            }
        }
    }
    penaltyScore() {
        let result = 0;
        for (let y = 0; y < this.size; y++) {
            let runColor = false;
            let runLength = 0;
            const history = [0, 0, 0, 0, 0, 0, 0];
            for (let x = 0; x < this.size; x++) {
                if (this.modules[y][x] === runColor) {
                    runLength++;
                    if (runLength === 5)
                        result += 3;
                    else if (runLength > 5)
                        result++;
                }
                else {
                    this.addHistory(runLength, history);
                    if (!runColor)
                        result += this.countPatterns(history) * 40;
                    runColor = this.modules[y][x];
                    runLength = 1;
                }
            }
            result += this.terminateAndCount(runColor, runLength, history) * 40;
        }
        for (let x = 0; x < this.size; x++) {
            let runColor = false;
            let runLength = 0;
            const history = [0, 0, 0, 0, 0, 0, 0];
            for (let y = 0; y < this.size; y++) {
                if (this.modules[y][x] === runColor) {
                    runLength++;
                    if (runLength === 5)
                        result += 3;
                    else if (runLength > 5)
                        result++;
                }
                else {
                    this.addHistory(runLength, history);
                    if (!runColor)
                        result += this.countPatterns(history) * 40;
                    runColor = this.modules[y][x];
                    runLength = 1;
                }
            }
            result += this.terminateAndCount(runColor, runLength, history) * 40;
        }
        for (let y = 0; y < this.size - 1; y++) {
            for (let x = 0; x < this.size - 1; x++) {
                const color = this.modules[y][x];
                if (color === this.modules[y][x + 1] && color === this.modules[y + 1][x] &&
                    color === this.modules[y + 1][x + 1])
                    result += 3;
            }
        }
        const dark = this.modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
        const total = this.size * this.size;
        result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
        return result;
    }
    addHistory(length, history) {
        if (history[0] === 0)
            length += this.size;
        history.pop();
        history.unshift(length);
    }
    countPatterns(history) {
        const unit = history[1];
        const core = unit > 0 && history[2] === unit && history[3] === unit * 3 &&
            history[4] === unit && history[5] === unit;
        return (core && history[0] >= unit * 4 && history[6] >= unit ? 1 : 0) +
            (core && history[6] >= unit * 4 && history[0] >= unit ? 1 : 0);
    }
    terminateAndCount(color, length, history) {
        if (color) {
            this.addHistory(length, history);
            length = 0;
        }
        length += this.size;
        this.addHistory(length, history);
        return this.countPatterns(history);
    }
}
function encodeMediumQr(text) {
    const bytes = [...new TextEncoder().encode(text)];
    let version = 1;
    for (; version <= 40; version++) {
        const countBits = version <= 9 ? 8 : 16;
        if (bytes.length < 2 ** countBits && 4 + countBits + bytes.length * 8 <= dataCodewords(version) * 8)
            break;
    }
    if (version > 40)
        throw new RangeError('Data too long');
    const bits = [];
    appendBits(4, 4, bits);
    appendBits(bytes.length, version <= 9 ? 8 : 16, bits);
    bytes.forEach(value => appendBits(value, 8, bits));
    const capacity = dataCodewords(version) * 8;
    appendBits(0, Math.min(4, capacity - bits.length), bits);
    appendBits(0, (8 - bits.length % 8) % 8, bits);
    let pad = 0xec;
    while (bits.length < capacity) {
        appendBits(pad, 8, bits);
        pad ^= 0xec ^ 0x11;
    }
    const data = [];
    for (let index = 0; index < bits.length; index++) {
        if ((index & 7) === 0)
            data.push(0);
        data[data.length - 1] |= bits[index] << (7 - (index & 7));
    }
    return new MediumQrMatrix(version, data);
}
function matrixPath(modules, margin) {
    const commands = [];
    modules.forEach((row, y) => {
        let start = null;
        row.forEach((dark, x) => {
            if (dark && start === null)
                start = x;
            if ((!dark || x === row.length - 1) && start !== null) {
                const end = dark && x === row.length - 1 ? x + 1 : x;
                commands.push(`M${start + margin} ${y + margin}h${end - start}v1H${start + margin}z`);
                start = null;
            }
        });
    });
    return commands.join('');
}
function validatedPageUrl(value) {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 2_048)
        return null;
    try {
        const parsed = new URL(value);
        if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
            parsed.username !== '' || parsed.password !== '')
            return null;
        return `${parsed.origin}${parsed.pathname}`;
    }
    catch {
        return null;
    }
}
function qrShape(pageUrl) {
    const validated = validatedPageUrl(pageUrl);
    if (validated === null)
        return null;
    try {
        const matrix = encodeMediumQr(validated);
        const margin = 4;
        return Object.freeze({ size: matrix.size + margin * 2, path: matrixPath(matrix.modules, margin) });
    }
    catch {
        return null;
    }
}
export function createQrCodeSvg(pageUrl) {
    const shape = qrShape(pageUrl);
    if (shape === null)
        return null;
    return Object.freeze({
        kind: 'qr_svg',
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${shape.size} ${shape.size}" shape-rendering="crispEdges"><path fill="#fff" d="M0 0h${shape.size}v${shape.size}H0z"/><path fill="#111" d="${shape.path}"/></svg>`
    });
}
function browserEncoderSource() {
    return [
        `const MEDIUM_ECC_CODEWORDS_PER_BLOCK=${JSON.stringify(MEDIUM_ECC_CODEWORDS_PER_BLOCK)};`,
        `const MEDIUM_ERROR_CORRECTION_BLOCKS=${JSON.stringify(MEDIUM_ERROR_CORRECTION_BLOCKS)};`,
        appendBits, bit, rawDataModules, dataCodewords, reedSolomonMultiply,
        reedSolomonDivisor, reedSolomonRemainder, MediumQrMatrix, encodeMediumQr,
        matrixPath
    ].map(value => typeof value === 'string' ? value : `${value.toString()};`).join('');
}
let browserScript;
export function qrCodeBrowserScript() {
    if (browserScript !== undefined)
        return browserScript;
    browserScript = `(()=>{${browserEncoderSource()}try{const protocol=location.protocol;if(!/^https?:$/.test(protocol))return;const source=document.getElementById('groupmate-document');if(!source)return;const pictureDocument=JSON.parse(source.textContent||'');if(pictureDocument.showQRCode!==true)return;const holder=document.getElementById('groupmate-qr');if(!holder)return;const payload=location.origin+location.pathname;if(new TextEncoder().encode(payload).byteLength>2048)return;const matrix=encodeMediumQr(payload);const margin=4;const size=matrix.size+margin*2;const ns='http:'+'//www.w3.org/2000/svg';const svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 '+size+' '+size);svg.setAttribute('shape-rendering','crispEdges');const background=document.createElementNS(ns,'path');background.setAttribute('fill','#fff');background.setAttribute('d','M0 0h'+size+'v'+size+'H0z');const foreground=document.createElementNS(ns,'path');foreground.setAttribute('fill','#111');foreground.setAttribute('d',matrixPath(matrix.modules,margin));svg.append(background,foreground);holder.textContent='';holder.appendChild(svg);holder.hidden=false}catch{}})();`;
    return browserScript;
}
