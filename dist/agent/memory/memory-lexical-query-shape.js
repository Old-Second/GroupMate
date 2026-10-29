/**
 * 词法召回的 MATCH 形状。归一化把中文切成「每字 + 相邻二字」，直接把全部 token OR 起来会让
 * 「我」「的」「是」这类覆盖接近全库的 token 把候选集撑成整个索引，bm25 必须给所有候选打分，
 * 延迟随记录数线性上升（本机 4096 条实测 p50 1.2 s / p95 3.1 s，远超 500 ms 硬顶）。
 *
 * 这里只剔除覆盖面接近全库的 token，其余全部保留：候选集收窄，但区分度最高的词一个都不丢。
 * 相对地，「只取最稀有的 N 个 token」会让 bm25 在同词文档里失去区分度——本机 4096 条下目标记录
 * 只有 20% 能被召回，因此不采用。
 */
export const MEMORY_LEXICAL_QUERY_SHAPE_V1 = Object.freeze({
    /** 文档频次超过索引记录数这一比例的 token 不参与 MATCH。 */
    elidedDocumentRatio: 0.1,
    /** 小库里比例阈值会过于激进，低于该绝对条数不剔除任何 token。 */
    elidedDocumentFloor: 64,
    /** 所有 token 都覆盖接近全库时的兜底：保留最稀有的若干个，查询仍然有结果。 */
    retainedRarestTokens: 4
});
function matchExpression(tokens) {
    return tokens.map(token => `"${token}"`).join(' OR ');
}
/**
 * 构造 FTS5 MATCH 表达式。`documentFrequencies` 为 token 到包含它的文档数的映射，
 * 缺失视为 0（索引里没有这个词，扫描代价为零，一律保留）。
 */
export function memoryLexicalBoundedMatchV1(tokens, documentFrequencies, indexedRecords) {
    const threshold = Math.max(MEMORY_LEXICAL_QUERY_SHAPE_V1.elidedDocumentFloor, Math.floor(indexedRecords * MEMORY_LEXICAL_QUERY_SHAPE_V1.elidedDocumentRatio));
    const frequency = (token) => documentFrequencies.get(token) ?? 0;
    const kept = tokens.filter(token => frequency(token) <= threshold);
    if (kept.length > 0)
        return matchExpression(kept);
    const rarest = new Set([...tokens]
        .sort((left, right) => frequency(left) - frequency(right) ||
        right.length - left.length || (left < right ? -1 : 1))
        .slice(0, MEMORY_LEXICAL_QUERY_SHAPE_V1.retainedRarestTokens));
    return matchExpression(tokens.filter(token => rarest.has(token)));
}
