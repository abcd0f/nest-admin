/** 将扁平父子记录按输入顺序组装成树；父节点缺失或存在循环时拒绝返回。 */
export function toTree<T extends { parentId: string; children: T[] }>(
  nodes: T[],
  getId: (node: T) => string,
): T[] {
  const byId = new Map(nodes.map((node) => [getId(node), node]));
  const roots: T[] = [];
  for (const node of nodes) {
    if (node.parentId === '0') roots.push(node);
    else byId.get(node.parentId)?.children.push(node);
  }

  const queue = [...roots];
  for (let index = 0; index < queue.length; index++) {
    for (const child of queue[index].children) queue.push(child);
  }
  if (queue.length !== nodes.length) throw new Error('树存在缺失父节点或循环，请先修复数据');
  return roots;
}
