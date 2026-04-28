import { Router, type IRouter } from "express";
import healthRouter from "./health";
import newsRouter from "./news";
import marketsRouter from "./markets";
import aiRouter from "./ai";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(newsRouter);
router.use("/markets", marketsRouter);
router.use("/ai", aiRouter);
router.use("/admin", adminRouter);

export default router;
