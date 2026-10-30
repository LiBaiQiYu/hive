/**
 * Schema 汇总出口。
 *
 * 设计取舍：不定义 Drizzle `relations()`，所有关联查询显式写出 leftJoin / innerJoin。
 * 理由：D1 没有懒加载，隐式 relation 只会让"到底发了几条 SQL"变得不可见；
 * 20~100 人规模下显式 join 更易读、也更容易在一次 batch 中完成。
 */
export * from './_shared';
export * from './users';
export * from './players';
export * from './competition';
export * from './jobs';
export * from './audit';
