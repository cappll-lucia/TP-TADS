import { prisma } from '$lib/server/lucia/prisma';
import type { PageServerLoad, Actions } from './$types';
import { fail } from '@sveltejs/kit';
import { reviewSchema } from './reviewSchema';
import { turnSolicitationSchema } from './turnSolicitationSchema';
import { notifyTurnSolicitation } from '$lib/server/email/emailService';

function addDays(dateTime: Date, count_days = 0) {
	return new Date(new Date(dateTime).setDate(dateTime.getDate() + count_days));
}

export const load: PageServerLoad = async ({ params, locals }) => {
	// validation
	const user = await locals.auth.validate();
	const profesional_id = params.id;
	const profesional = await prisma.authUser.findUnique({
		where: { id: profesional_id },
		include: { services: true }
	});
	if (!profesional) {
		throw Error('Profesional not found');
	}

	//reviews
	const reviews = await prisma.review.findMany({
		where: {
			prof_id: profesional_id
		},
		include: {
			author: true,
			prof_user: true
		}
	});

	const userWrittenReviews = await prisma.review.findMany({
		where: {
			prof_id: profesional_id,
			author_id: user?.userId
		}
	});

	//appointments
	const busy_appointments = await prisma.appointment.findMany({
		where: { profesional_id, date: { gt: new Date() }, state: 'TO_DO' }
	});
	const busy_days = busy_appointments.map((x) => x.date);

	let available_turns: { date: Date; available: boolean }[] = [];

	for (let i = 1; i <= 7; i++) {
		const date = addDays(new Date(), i);
		const available = !busy_days.some((x) => x.getDay() == date.getDay());
		available_turns.push({ date, available });
	}

	return { profesional, user, reviews, userWrittenReviews, available_turns };
};

export const actions: Actions = {
	agendar: async ({ request, locals }) => {
		const { user } = await locals.auth.validateUser();
		if (!user) {
			return fail(401, { message: 'Unauntenticated' });
		}

		const formData = Object.fromEntries(await request.formData()) as Record<string, string>;
		const zodRes = turnSolicitationSchema.safeParse(formData);
		if (zodRes.success === false) {
			return fail(400, { message: 'Invalid request' });
		}

		const turn = await prisma.appointment.create({
			data: {
				client_id: user.userId,
				date: new Date(zodRes.data.turn),
				description: zodRes.data.desc,
				profesional_id: zodRes.data.profesional_id,
				state: 'UNCONFIRMED'
			}
		});

		prisma.authUser.findUnique({ where: { id: turn.profesional_id } })
			.then(prof => {
				if (!prof) return
				notifyTurnSolicitation({ to: prof.email, date: turn.date, clientName: user.name })
			})

		return {
			success: true,
			date: new Date(zodRes.data.turn)
		};
	},

	addReview: async ({ request, locals, params }) => {
		const formData = Object.fromEntries(await request.formData()) as Record<string, string>;
		const zodResult = reviewSchema.safeParse(formData);
		if (!zodResult.success) {
			return {
				data: {
					...formData
				},
				errors: zodResult.error.flatten().fieldErrors
			};
		}
		const user = await locals.auth.validate();
		if (!user) return fail(401, { message: 'Usuario no autenticado' });
		const profesionalId = params.id;
		await prisma.review.create({
			data: {
				author_id: user.userId,
				prof_id: profesionalId,
				comment: formData.comment,
				score: Number(formData.score)
			}
		});
		return {
			status: 200
		};
	},
	editReview: async ({ request, locals }) => {
		const formData = Object.fromEntries(await request.formData()) as Record<string, string>;
		const reviewId = formData.id;
		delete formData.id;
		const zodResult = reviewSchema.safeParse(formData);
		if (!zodResult.success) {
			return {
				data: { ...formData },
				errors: zodResult.error.flatten().fieldErrors
			};
		}
		const user = await locals.auth.validate();
		if (!user) return fail(401, { message: 'Usuario no autenticado' });
		await prisma.review.update({
			data: {
				comment: formData.comment,
				score: Number(formData.score),
				edited_at: new Date()
			},
			where: {
				id: reviewId
			}
		});
		return {
			status: 200
		};
	},
	deleteReview: async ({ request }) => {
		const formData = Object.fromEntries(await request.formData()) as Record<string, string>;
		await prisma.review.delete({
			where: {
				id: formData.id
			}
		});
	}
};
