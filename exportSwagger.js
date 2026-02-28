import fs from "fs";
import path from "path";
import swaggerUiDist from "swagger-ui-dist";
import swaggerJSDoc from "swagger-jsdoc";

const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Dataset Coordinator",
      version: "1.0.0",
    },
  },
  apis: ["./server.js"],
});

const swaggerPath = swaggerUiDist.getAbsoluteFSPath();

const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Dataset Coordinator API</title>
  <link rel="stylesheet" href="./swagger-ui.css" />
</head>
<body>
<div id="swagger-ui"></div>

<script src="./swagger-ui-bundle.js"></script>
<script>
const spec = ${JSON.stringify(swaggerSpec)};

SwaggerUIBundle({
  spec,
  dom_id: '#swagger-ui'
});
</script>
</body>
</html>
`;

fs.writeFileSync("./docs/api.html", html);

// copy swagger assets
fs.copyFileSync(
  path.join(swaggerPath, "swagger-ui.css"),
  "./docs/swagger-ui.css",
);

fs.copyFileSync(
  path.join(swaggerPath, "swagger-ui-bundle.js"),
  "./docs/swagger-ui-bundle.js",
);

console.log("Swagger HTML exported.");
