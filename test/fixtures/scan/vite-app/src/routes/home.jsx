import { Shell } from "@/components/layout/Shell";
import { api } from "../lib/api.js";
const lazy = () => import("./about");

export const Home = () => [Shell, api, lazy];
