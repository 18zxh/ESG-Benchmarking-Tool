"""Concise interface copy; never applied to methodology or user documents."""


def simplify_interface_copy(namespace, filename, text):
    if namespace == 'exchange' and filename == 'index.html':
        for note in (
            '<span>保存到统一本机资料库后可恢复继续</span>',
            '<span>原报告与对标结果保存到统一本机资料库</span>',
        ):
            text = text.replace(note, '')

    if filename not in {'workbench.js', 'benchmark.js', 'workbench-view.js'}:
        return text

    if namespace == 'exchange' and filename == 'workbench.js':
        # Clear the previous notice without announcing ordinary navigation.
        text = text.replace("message('已切换市场；另一市场的当前项目仍保留在本页。');", "message('');")
        text = text.replace("message('已新建空项目。');", "message('');")

    replacements = {
        '项目、原 PDF 和人工意见已保存到统一本机资料库。': '项目已保存。',
        '草稿、原报告与评论已保存到统一本机资料库。密钥未保存。': '草稿已保存。',
        '草稿、原报告及评论已保存到统一本机资料库。': '草稿已保存。',
        '横向对标草稿已保存到统一本机资料库，包含原报告、映射和已完成结果。': '对标草稿已保存。',
        '横向对标草稿已恢复；现有判断保留，原报告按文件指纹重新登记。': '对标草稿已恢复。',
        '草稿已恢复，原 PDF 已重新登记；模型密钥需按服务状态重新连接。': '草稿已恢复。',
        '草稿与评论已恢复，模型按当前连接状态使用。': '草稿与评论已恢复。',
        '已根据文件指纹重新关联原 PDF。': '原 PDF 已重新关联。',
        '原 PDF 不在本机服务内存中，请恢复草稿或重新上传。': '原 PDF 尚未载入，请恢复草稿或重新上传。',
        '评论已保存到本机，导出时会与本项初评和原文一起保留。': '评论已保存。',
        '保存会将原 PDF、解析文本、初评及人工意见存入统一本机资料库。连接同一资料库并选择同一企业项目即可恢复。': '保存项目后可恢复原报告、初评及人工意见。',
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    return text
