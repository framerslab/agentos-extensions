# The lifecycle test's fake product: the report url the scheduler forwards to, recording every report. Built from the
# pack's folder by image/test/compose.yml.
FROM node:24-bookworm-slim
WORKDIR /product
COPY image/test/product.mjs ./product.mjs
USER node
EXPOSE 8790
CMD ["node", "product.mjs"]
