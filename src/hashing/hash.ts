/**
 * MurmurHash3 implementation for AI Lens
 * Compatible with Cursor's internal hash algorithm
 */

export class HashUtils {
  /**
   * MurmurHash3 32位哈希算法实现
   * 与Cursor内部使用的算法完全一致
   */
  static murmurhash3(str: string, seed: number = 0): string {
    let h1 = seed;
    const c1 = 0xcc9e2d51;
    const c2 = 0x1b873593;

    const len = str.length;
    const nblocks = len >>> 2; // len / 4

    // 32位乘法运算，处理溢出
    const multiply32 = (a: number, b: number): number => {
      return ((a & 0xffff) * b + (((a >>> 16) * b & 0xffff) << 16)) & 0xffffffff;
    };

    // 32位左旋转
    const rotateLeft32 = (x: number, n: number): number => {
      return (x << n) | (x >>> (32 - n));
    };

    // 处理完整的4字节块
    for (let i = 0; i < nblocks; i++) {
      const i4 = i * 4;
      let k1 = (str.charCodeAt(i4) & 0xff) |
        ((str.charCodeAt(i4 + 1) & 0xff) << 8) |
        ((str.charCodeAt(i4 + 2) & 0xff) << 16) |
        ((str.charCodeAt(i4 + 3) & 0xff) << 24);

      k1 = multiply32(k1, c1);
      k1 = rotateLeft32(k1, 15);
      k1 = multiply32(k1, c2);

      h1 ^= k1;
      h1 = rotateLeft32(h1, 13);
      h1 = multiply32(h1, 5);
      h1 = (h1 + 0xe6546b64) & 0xffffffff;
    }

    // 处理剩余字节
    const tail = len & 3;
    if (tail > 0) {
      let k1 = 0;
      const tailStart = nblocks * 4;

      if (tail >= 3) { k1 ^= (str.charCodeAt(tailStart + 2) & 0xff) << 16; }
      if (tail >= 2) { k1 ^= (str.charCodeAt(tailStart + 1) & 0xff) << 8; }
      if (tail >= 1) { k1 ^= (str.charCodeAt(tailStart) & 0xff); }

      k1 = multiply32(k1, c1);
      k1 = rotateLeft32(k1, 15);
      k1 = multiply32(k1, c2);
      h1 ^= k1;
    }

    // 最终化
    h1 ^= len;
    h1 ^= h1 >>> 16;
    h1 = multiply32(h1, 0x85ebca6b);
    h1 ^= h1 >>> 13;
    h1 = multiply32(h1, 0xc2b2ae35);
    h1 ^= h1 >>> 16;

    return (h1 >>> 0).toString(16);
  }

  /**
   * 计算代码行的哈希值
   * @param fileName 文件名
   * @param operation 操作类型 ('+' | '-')
   * @param content 代码内容
   * @returns 8位十六进制哈希字符串
   */
  static calculateCodeHash(fileName: string, operation: '+' | '-', content: string): string {
    const hashInput = `${fileName}:${operation}${content}`;
    return this.murmurhash3(hashInput, 0);
  }

  /**
   * 验证哈希格式是否正确
   * @param hash 要验证的哈希值
   * @returns 是否为有效的8位十六进制字符串
   */
  static isValidHash(hash: string): boolean {
    return typeof hash === 'string' && /^[a-f0-9]{8}$/.test(hash);
  }

  /**
   * 为给定的代码行尝试不同的操作，查找匹配的哈希
   * @param fileName 文件名
   * @param content 代码内容
   * @param targetHash 目标哈希值
   * @returns 匹配的操作类型，如果没有匹配则返回null
   */
  static findMatchingOperation(fileName: string, content: string, targetHash: string): '+' | '-' | null {
    const operations: ('+' | '-')[] = ['+', '-'];

    for (const op of operations) {
      const calculatedHash = this.calculateCodeHash(fileName, op, content);
      if (calculatedHash === targetHash) {
        return op;
      }
    }

    return null;
  }
}
