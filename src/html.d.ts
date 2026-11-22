//* wrangler bundles an imported .html file as a Text module: its default export is the file's content
declare module "*.html" {
	const content: string;
	export default content;
}
