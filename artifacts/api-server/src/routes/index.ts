import { Router, type IRouter } from "express";
import healthRouter from "./health";
import newsRouter from "./news";
import marketsRouter from "./markets";
import aiRouter from "./ai";
import adminRouter from "./admin";
import opportunitiesRouter from "./opportunities";
import userRouter from "./user";
import paymentsRouter from "./payments";
import portfolioRouter from "./portfolio";
import priceAlertsRouter from "./price-alerts";
import calculatorsRouter from "./calculators";
import subscriptionLifecycleRouter from "./subscription-lifecycle";

const router: IRouter = Router();

router.use(healthRouter);
router.use(newsRouter);
router.use("/markets", marketsRouter);
router.use("/ai", aiRouter);
router.use("/admin", adminRouter);
router.use("/user", userRouter);
router.use(paymentsRouter);
router.use(portfolioRouter);
router.use(priceAlertsRouter);
router.use(subscriptionLifecycleRouter);
router.use(calculatorsRouter);
router.use(opportunitiesRouter);

export default router;
