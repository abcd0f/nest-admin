import { describe, expect, it } from 'vitest';
import { toTree } from './tree.js';

interface TreeNode {
  id: string;
  parentId: string;
  children: TreeNode[];
}

describe('toTree', () => {
  it('保持输入顺序，正确挂载先于父节点出现的子节点', () => {
    const nodes: TreeNode[] = [
      { id: '3', parentId: '1', children: [] },
      { id: '2', parentId: '0', children: [] },
      { id: '1', parentId: '0', children: [] },
      { id: '4', parentId: '1', children: [] },
    ];
    const tree = toTree(nodes, (node) => node.id);
    expect(tree.map((node) => node.id)).toEqual(['2', '1']);
    expect(tree[1].children.map((node) => node.id)).toEqual(['3', '4']);
    expect(toTree<TreeNode>([], (node) => node.id)).toEqual([]);
  });

  it.each([
    [{ id: '1', parentId: '99', children: [] }],
    [{ id: '1', parentId: '1', children: [] }],
    [
      { id: '1', parentId: '2', children: [] },
      { id: '2', parentId: '1', children: [] },
      { id: '3', parentId: '0', children: [] },
    ],
  ])('父节点缺失或存在循环时拒绝返回部分树', (...nodes) => {
    expect(() => toTree(nodes, (node) => node.id)).toThrow('树存在缺失父节点或循环');
  });
});
