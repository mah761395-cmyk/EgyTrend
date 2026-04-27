import { Router, type IRouter } from "express";
import healthRouter from "./health";
import newsRouter from "./news";
import marketsRouter from "./markets";

const router: IRouter = Router();

router.use(healthRouter);
router.use(newsRouter);
router.use("/markets", marketsRouter);

export default router;
