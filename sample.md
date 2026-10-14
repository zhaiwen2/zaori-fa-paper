# Attention and Scientific Reading

This is a local example document. It does not call any API until you click **Start translation**. Mathematical expressions, source code, and image paths are preserved while the surrounding text is translated.

## Abstract

Scientific reading requires both accurate terminology and a clear understanding of context. A bilingual reader helps researchers compare the original evidence with a translation, paragraph by paragraph.

Our illustrative experiment uses 120 documents and reports an accuracy of 95.2%. These numbers describe a demonstration, not a real research result.

## Mathematical notation

The attention operation is defined as $\mathrm{Attention}(Q,K,V)=\mathrm{softmax}(QK^T/\sqrt{d_k})V$.

$$
E = mc^2
$$

The formula above should remain unchanged after translation.

## A comparison table

| Method | Documents | Description |
| --- | --- | --- |
| Baseline | 60 | Direct reading |
| Bilingual | 60 | Reading with translated paragraphs |

## Reproducible code

```python
def mean(values):
    return sum(values) / len(values)
```

Code is displayed as written and is never executed by the reader.

## Conclusion

Reliable translation should preserve technical meaning, numerical results, and document structure. Readers should always be able to consult the original paper.

## References

This section is intentionally preserved in its original language.
